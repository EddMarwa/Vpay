const enabledToggle = document.querySelector("#enabledToggle");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const statusDetail = document.querySelector("#statusDetail");
const errorBox = document.querySelector("#errorBox");
const authView = document.querySelector("#authView");
const mainView = document.querySelector("#mainView");
const emailInput = document.querySelector("#emailInput");
const passwordInput = document.querySelector("#passwordInput");
const inviteInput = document.querySelector("#inviteInput");
const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const signOutButton = document.querySelector("#signOutButton");
const accountEmail = document.querySelector("#accountEmail");
const accountRole = document.querySelector("#accountRole");
const billingCard = document.querySelector("#billingCard");
const billingPlan = document.querySelector("#billingPlan");
const billingBadge = document.querySelector("#billingBadge");
const billingTotal = document.querySelector("#billingTotal");
const billingBalance = document.querySelector("#billingBalance");
const billingExpiry = document.querySelector("#billingExpiry");
const creditStore = document.querySelector("#creditStore");
const storeSub = document.querySelector("#storeSub");
const planList = document.querySelector("#planList");
const pendingPaymentBox = document.querySelector("#pendingPaymentBox");
const pendingCopy = document.querySelector("#pendingPaymentBox .pending-copy");
const openInvoiceButton = document.querySelector("#openInvoiceButton");
const cancelPaymentButton = document.querySelector("#cancelPaymentButton");
const storeNote = document.querySelector("#storeNote");

let lastBilling = null;
let lastBlocked = false;
let toggleLockTimer = null;
let lastToggleAt = 0;
let cancelTimer = null;
const store = { plans: [], pending: null, checkout: null };

let port;
let heartbeat;
let panelTabId = null;
let reconnectAttempts = 0;

start();

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    showError("No active browser tab was found.");
    enabledToggle.disabled = true;
    return;
  }
  panelTabId = tab.id;

  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  enabledToggle.checked = interceptionEnabled;

  // xyz-panel is a service-worker protocol identifier kept for compatibility.
  port = chrome.runtime.connect({ name: `xyz-panel:${panelTabId}` });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);

  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => safeSend({ type: "heartbeat" }), 15_000);
  safeSend({ type: "auth-status" });
}

function handleDisconnect() {
  clearInterval(heartbeat);
  heartbeat = null;
  port = null;
  // Chrome suspends the service worker when it idles, which drops our port.
  // Reconnect automatically (the worker re-syncs billing state on connect);
  // stop only after the panel is hidden (i.e. actually closed).
  if (document.hidden || reconnectAttempts >= 10) {
    setStatus(false, "Disconnected", "The panel lost its connection. Reopen it to continue.");
    return;
  }
  reconnectAttempts += 1;
  setTimeout(() => {
    start()
      .then(() => {
        reconnectAttempts = 0;
      })
      .catch(() => {});
  }, 1500);
}

enabledToggle.addEventListener("change", () => {
  hideError();
  setStatus(false, enabledToggle.checked ? "Activating…" : "Turning off…", "Updating the current tab.");
  if (enabledToggle.checked) lastToggleAt = Date.now();
  safeSend({ type: "set-enabled", enabled: enabledToggle.checked });
});

loginButton.addEventListener("click", () => {
  hideError();
  safeSend({
    type: "auth-login",
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
});

registerButton.addEventListener("click", () => {
  hideError();
  safeSend({
    type: "auth-register",
    email: emailInput.value.trim(),
    password: passwordInput.value,
    inviteCode: inviteInput.value.trim(),
  });
});

signOutButton.addEventListener("click", () => safeSend({ type: "auth-logout" }));

function handleMessage(message) {
  switch (message.type) {
    case "auth-state":
      renderAuth(message);
      break;
    case "auth-required":
      renderAuth({ authenticated: false, accountDisabled: false });
      showError("Sign in to activate Vpay.");
      break;
    case "billing-blocked":
      renderAuth({
        authenticated: true,
        accountDisabled: false,
        billing: message.billing,
        billingBlocked: true,
      });
      updateStoreFrom(message);
      setStatus(false, "Needs top-up", "Add credits to activate Vpay.");
      break;
    case "attached":
      enabledToggle.checked = true;
      unlockToggle();
      setStatus(true, "Active", "Vpay is on.");
      hideError();
      break;
    case "state":
      // The toggle mirrors the stored intent (message.enabled) so transient
      // errors or a page refresh can never desync it from the real state.
      if (typeof message.enabled === "boolean") {
        enabledToggle.checked = message.enabled;
        if (message.enabled) unlockToggle();
      }
      setStatus(
        message.attached,
        message.attached ? "Active" : "Inactive",
        message.attached ? "Vpay is on." : "Vpay is off.",
      );
      break;
    case "detached":
      setStatus(false, "Inactive", message.reason || "Vpay is off.");
      break;
    case "billing-update":
      renderBilling(message.billing || null, message.billing?.entitled === false || message.billingBlocked);
      updateStoreFrom(message);
      break;
    case "billing-checkout-created":
      store.pending = message.payment || store.pending;
      renderCreditStore();
      break;
    case "billing-checkout-error":
      showError(message.message || "Checkout failed.");
      renderCreditStore();
      break;
    case "billing-open-none":
      // The server has no pending invoice for this account anymore (paid,
      // expired or never created). Drop the stale pending box.
      store.pending = null;
      renderCreditStore();
      showError(message.message || "No pending payment found.");
      break;
    case "billing-payment-cancelled":
      store.pending = null;
      renderCreditStore();
      hideError();
      setStatus(false, "Cancelled", "Payment cancelled. You can buy credits again anytime.");
      break;
    case "billing-purchased":
      if (message.billing && message.billing.entitled) {
        setStatus(true, "Active", "Credits added — Vpay is on.");
      } else {
        setStatus(false, "Top up", "Credits added. Buy more to keep going.");
      }
      break;
    case "error":
      // Don't leave the switch in a broken "on but not working" state: revert
      // it and lock it briefly when this failure follows the user's own attempt
      // to turn Vpay on. A later successful state/attached message unlocks it.
      if (Date.now() - lastToggleAt < 4000) {
        lockToggle();
      }
      setStatus(false, "Needs attention", "Something went wrong.");
      showError(message.message);
      break;
  }
}

function renderAuth(state) {
  const authed = state.authenticated && !state.accountDisabled;
  authView.hidden = authed;
  mainView.hidden = !authed;
  if (authed && state.user) {
    accountEmail.textContent = state.user.email || "unknown";
    accountRole.textContent = state.user.role || "user";
  }
  renderBilling(state.billing || null, state.billingBlocked || (state.billing && state.billing.entitled === false));
  updateStoreFrom(state);
  if (state.accountDisabled) {
    showError("This account has been disabled by the administrator.");
  }
}

function renderBilling(billing, blocked) {
  lastBilling = billing || null;
  lastBlocked = Boolean(blocked);
  if (!billing) {
    billingCard.hidden = true;
    renderCreditStore();
    return;
  }
  billingCard.hidden = false;
  billingTotal.textContent = String(billing.used ?? 0);
  billingBalance.textContent = String(billing.creditsRemaining ?? 0);
  billingExpiry.textContent =
    billing.planType === "time" && billing.expiresAt
      ? new Date(billing.expiresAt).toLocaleString([], {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "\u2014";
  if (blocked || billing.entitled === false) {
    billingPlan.textContent = "No active plan";
    billingBadge.hidden = false;
  } else {
    billingPlan.textContent = billing.planName ? `Plan: ${billing.planName}` : "Free trial";
    billingBadge.hidden = true;
  }
  renderCreditStore();
}

// ---------------------------------------------------------------- credit store

function updateStoreFrom(message) {
  if (!message) return;
  if (Array.isArray(message.plans)) store.plans = message.plans;
  if (message.pendingPayment !== undefined) store.pending = message.pendingPayment;
  if (message.checkout) {
    store.checkout = message.checkout;
    if (message.checkout.provider === undefined && message.provider) {
      store.checkout.provider = message.provider;
    }
  } else if (message.provider) {
    store.checkout = store.checkout || {};
    store.checkout.provider = message.provider;
  }
  renderCreditStore();
}

function usd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function renderCreditStore() {
  const checkout = store.checkout || {};
  const provider = checkout.provider || null;
  const entitled = Boolean(lastBilling && lastBilling.entitled);
  const plans = (store.plans || []).filter((p) => p && p.type === "usage");
  // Show the store for the mock dev provider too (instant "Add") — but the
  // crypto (Plisio) flow only appears once the server reports it as active.
  const showStore = (provider === "plisio" || provider === "mock") && plans.length > 0;
  const pending = store.pending && store.pending.status === "pending" ? store.pending : null;

  creditStore.hidden = !showStore;
  if (!showStore) return;
  resetCancelButton(); // always start from a clean "Cancel" state

  const min = Number(checkout.minPurchaseUsd || 0);
  const coin = checkout.defaultCoin || (checkout.coins && checkout.coins[0]) || "USDT_TRX";
  const tag =
    provider === "plisio"
      ? checkout.demo
        ? "LOCAL DEMO \u00b7 "
        : ""
      : "Sandbox \u00b7 ";
  if (entitled) {
    storeSub.textContent = `${tag}Top up credits.`;
  } else if (provider === "plisio") {
    storeSub.textContent = checkout.demo
      ? `${tag}No real money \u2014 simulated invoices.`
      : min > 0
        ? `${tag}Minimum ${usd(min)} \u00b7 default coin ${coin}`
        : `${tag}Pay with ${coin}`;
  } else {
    storeSub.textContent = `${tag}Credits are added immediately.`;
  }

  pendingPaymentBox.hidden = !pending;
  planList.hidden = Boolean(pending);
  if (pending) {
    pendingCopy.textContent = `Payment pending: ${pending.planName} — ${pending.credits} credits for ${usd(pending.amountUsd)}.`;
  } else {
    renderPlanList(plans, min, provider);
  }
}

function renderPlanList(plans, min, provider) {
  planList.textContent = "";
  const isCrypto = provider === "plisio";
  for (const plan of plans) {
    const price = Number(plan.price_cents || 0) / 100;
    const belowMin = isCrypto && min > 0 && price < min;
    const row = document.createElement("div");
    row.className = "plan-row";

    const info = document.createElement("div");
    info.className = "plan-info";
    const name = document.createElement("strong");
    name.textContent = plan.name || "Credits";
    const meta = document.createElement("span");
    meta.className = "plan-meta";
    meta.textContent = `${plan.credits || 0} credits · ${usd(price)}`;
    info.append(name, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn primary small buy-plan";
    button.dataset.planId = String(plan.id);
    if (belowMin) {
      button.disabled = true;
      button.textContent = `Min ${usd(min)}`;
      button.title = `Minimum purchase is ${usd(min)}`;
    } else {
      button.textContent = isCrypto ? "Buy" : "Add";
    }
    row.append(info, button);
    planList.append(row);
  }
  const noPacks = storeNote;
  noPacks.hidden = plans.length > 0;
  noPacks.textContent = "No credit packs available right now.";
}

openInvoiceButton.addEventListener("click", () => {
  hideError();
  safeSend({ type: "billing-open-invoice" });
});

cancelPaymentButton.addEventListener("click", () => {
  hideError();
  resetCancelButton();
  cancelPaymentButton.disabled = true;
  cancelPaymentButton.textContent = "Cancelling\u2026";
  safeSend({ type: "billing-cancel-payment" });
  // Self-heal: if the worker never answers (suspended mid-request, reply
  // lost), put the button back so the user can retry.
  cancelTimer = setTimeout(() => {
    cancelTimer = null;
    resetCancelButton();
    showError("No response from the server. Please try again.");
  }, 8000);
});

planList.addEventListener("click", (event) => {
  const button = event.target.closest("button.buy-plan");
  if (!button || button.disabled) return;
  hideError();
  button.disabled = true;
  button.textContent = "Starting\u2026";
  const provider = (store.checkout || {}).provider;
  if (provider === "plisio") {
    safeSend({ type: "billing-checkout", planId: Number(button.dataset.planId) });
  } else {
    safeSend({ type: "billing-purchase", planId: Number(button.dataset.planId) });
  }
});

function setStatus(active, title, detail) {
  statusDot.classList.toggle("active", active);
  statusText.textContent = title;
  statusDetail.textContent = detail;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
}

function resetCancelButton() {
  if (cancelTimer) {
    clearTimeout(cancelTimer);
    cancelTimer = null;
  }
  cancelPaymentButton.disabled = false;
  cancelPaymentButton.textContent = "Cancel";
}

function lockToggle() {
  enabledToggle.checked = false; // never leave a broken half-on state
  enabledToggle.disabled = true;
  if (toggleLockTimer) clearTimeout(toggleLockTimer);
  // Auto-recover so a retry is possible after the environment settles; any
  // successful state/attached message unlocks it sooner.
  toggleLockTimer = setTimeout(unlockToggle, 6000);
}

function unlockToggle() {
  enabledToggle.disabled = false;
  if (toggleLockTimer) {
    clearTimeout(toggleLockTimer);
    toggleLockTimer = null;
  }
}

function safeSend(message) {
  try {
    port?.postMessage(message);
  } catch {
    // The service worker handles detachment when this connection disappears.
  }
}

