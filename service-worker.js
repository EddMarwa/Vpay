// Build-time constant — the server this extension talks to.
// Production: https://freecreditbuilds.ink
// Local dev:  http://127.0.0.1:5055  
// Flip this line when switching environments; manifest host_permissions
// already covers both (<all_urls>).
const DEFAULT_SERVER = "https://freecreditbuilds.ink";
const PROTOCOL_VERSION = "1.3";
const AUTH_KEY = "xyzAuth";

const attachedTabs = new Set();
const panelPorts = new Map();
const ranPageScripts = new Map(); // tabId -> Set(script id)

let configState = null; // { targetUrl, mockResponse, mockStatus, watchHosts, scripts, captureRules, engineVersion }
let accountDisabled = false;
let billingState = null;  // from GET /api/billing/status
let billingBlocked = false;
let billingPlans = [];    // active credit packs (type === "usage")
let pendingPayment = null; // latest pending crypto invoice for this user
let checkoutInfo = null;  // { minPurchaseUsd, coins, defaultCoin } + provider
let autoSignedOut = false; // one-shot guard so a burst of 401s signs out once

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const { interceptionEnabled } = await chrome.storage.local.get("interceptionEnabled");
  if (typeof interceptionEnabled !== "boolean") {
    await chrome.storage.local.set({ interceptionEnabled: true });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("xyz-panel:")) return;
  const tabId = Number(port.name.split(":")[1]);
  if (!Number.isInteger(tabId)) {
    port.disconnect();
    return;
  }

  const previousPort = panelPorts.get(tabId);
  if (previousPort && previousPort !== port) previousPort.disconnect();
  panelPorts.set(tabId, port);

  port.onMessage.addListener((message) => handlePanelMessage(tabId, port, message));
  port.onDisconnect.addListener(() => {
    // Closing/switching the panel must NOT stop interception — tabs stay
    // armed so xyz keeps working in every tab.
    if (panelPorts.get(tabId) === port) panelPorts.delete(tabId);
  });

  initializePanel(tabId, port);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  panelPorts.delete(tabId);
  ranPageScripts.delete(tabId);
});

if (chrome.sidePanel.onClosed) {
  // Intentionally no detach here: closing the panel keeps xyz armed in every
  // tab so interception keeps running in the background.
}

// ---------------------------------------------------------------- all-tabs mode

// Keep xyz armed in EVERY tab, not just the one with the panel open, so
// switching focus never disconnects interception.
async function armAllTabs() {
  if (!(await isAuthenticated()) || accountDisabled) return;
  if (billingBlocked) return;
  if (!configState) {
    try {
      await loadConfigAndEngine();
    } catch {
      return;
    }
  }
  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  if (!interceptionEnabled) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || attachedTabs.has(tab.id)) continue;
    await armTab(tab.id, panelPorts.get(tab.id));
  }
}

// Arm tabs created while the extension is enabled.
chrome.tabs.onCreated.addListener(() => {
  armAllTabs().catch(() => {});
});

// Re-arm periodically even if Chrome suspends the service worker.
chrome.alarms.create("xyz-rearm", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "xyz-rearm") return;
  armAllTabs().catch(() => {});
});

// Keep the offscreen policy engine alive while any tab is armed.
setInterval(() => {
  if (attachedTabs.size === 0) return;
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}))
    .catch(() => {});
}, 20_000);

// Poll billing from the server so the panel's Total / Balance / Expiry stay
// fresh even without new actions, and so a completed crypto payment is picked
// up within a few seconds. Also refreshes capture rules and drops stale
// pending captures. Polling tightens while a payment invoice is pending.
const BILLING_POLL_NORMAL_MS = 30_000;
const BILLING_POLL_PENDING_MS = 5_000;
let billingTimer = null;

function billingSnapshotKey() {
  const billing = billingState || {};
  const pending = pendingPayment || {};
  return JSON.stringify([
    billing.used,
    billing.creditsRemaining,
    billing.expiresAt,
    billing.entitled,
    pending.paymentId,
    pending.status,
  ]);
}

function notifyBillingChanged() {
  const payload = {
    type: "billing-update",
    billing: billingState,
    billingBlocked,
    plans: billingPlans,
    pendingPayment,
    checkout: checkoutInfo,
    provider: checkoutInfo && checkoutInfo.provider ? checkoutInfo.provider : null,
  };
  for (const port of panelPorts.values()) safePost(port, payload);
}

async function pollBillingOnce() {
  flushStaleCaptures();
  if (panelPorts.size > 0) await refreshCaptureRules();
  if (!(await isAuthenticated())) return;
  const wasBlocked = billingBlocked;
  const previous = billingSnapshotKey();
  await refreshBilling();
  // A payment landed and unblocked the account: arm every tab again.
  if (wasBlocked && !billingBlocked && billingState && billingState.entitled) {
    await armAllTabs().catch(() => {});
  }
  if (previous !== billingSnapshotKey()) notifyBillingChanged();
}

function scheduleBillingPoll() {
  if (billingTimer) {
    clearTimeout(billingTimer);
    billingTimer = null;
  }
  const delay = pendingPayment ? BILLING_POLL_PENDING_MS : BILLING_POLL_NORMAL_MS;
  billingTimer = setTimeout(async () => {
    billingTimer = null;
    await pollBillingOnce();
    scheduleBillingPoll();
  }, delay);
}

scheduleBillingPoll();

// ---------------------------------------------------------------- navigation

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  onPageChanged(details.tabId, details.url);
});

async function onPageChanged(tabId, url) {
  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  if (!interceptionEnabled) return;
  if (!(await isAuthenticated()) || accountDisabled) return;
  if (!configState) {
    try {
      await loadConfigAndEngine();
    } catch {
      return;
    }
  }

  // Keep every tab armed (not just the one with an open panel) so switching
  // focus never disconnects interception.
  await armTab(tabId, panelPorts.get(tabId));

  // Page scripts stay scoped to watch hosts (same as before).
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return;
  }
  const hosts = configState?.watchHosts || [];
  if (hosts.includes("<all_urls>") || hosts.includes(host)) {
    await runPageScripts(tabId);
  }
}

// ---------------------------------------------------------------- panel messages

async function initializePanel(tabId, port) {
  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  if (interceptionEnabled && (await isAuthenticated()) && !accountDisabled) {
    await refreshBilling();
    if (!billingBlocked) {
      try {
        await loadConfigAndEngine();
      } catch {
        // Non-fatal: the panel still shows state; re-arm retries later.
      }
      await armAllTabs();
      await runPageScripts(tabId);
    }
  }
  sendState(tabId, port);
  sendAuthState(port);
}

async function handlePanelMessage(tabId, port, message) {
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "set-enabled": {
      const enabled = Boolean(message.enabled);
      if (!enabled) {
        await chrome.storage.local.set({ interceptionEnabled: false });
        for (const tid of [...attachedTabs]) await detachFromTab(tid, "FK turned off");
        sendState(tabId, port);
        break;
      }

      // Turning ON must succeed on the tab the user is looking at, or we leave
      // the switch OFF (no half-on state). Only after that do we fan out.
      if (!(await isAuthenticated()) || accountDisabled) {
        safePost(port, { type: "auth-required" });
        sendState(tabId, port);
        break;
      }
      if (billingBlocked) {
        safePost(port, { type: "billing-blocked", billing: billingState });
        sendState(tabId, port);
        break;
      }
      let armed = false;
      try {
        await loadConfigAndEngine();
        armed = await armTab(tabId, port);
      } catch {
        // loadConfigAndEngine failure — same "couldn't turn on" outcome.
      }
      if (armed) {
        await chrome.storage.local.set({ interceptionEnabled: true });
        await armAllTabs(); // best-effort for the rest of the tabs
        await runPageScripts(tabId);
        sendState(tabId, port);
      } else {
        // Revert the stored intent so nothing keeps retrying in the background
        // and the switch truthfully stays off until the user retries.
        await chrome.storage.local.set({ interceptionEnabled: false });
        safePost(port, { type: "error", message: "Couldn't start FK on this page. Please try again." });
        sendState(tabId, port);
      }
      break;
    }

    case "auth-login":
      await handleLogin(tabId, port, message.email, message.password);
      break;

    case "auth-register":
      await handleRegister(tabId, port, message.email, message.password, message.inviteCode);
      break;

    case "auth-logout":
      await handleLogout(port);
      break;

    case "billing-checkout": {
      await handleCheckout(port, message.planId);
      break;
    }

    case "billing-open-invoice":
      await openPendingInvoice(port);
      break;

    case "billing-cancel-payment": {
      await cancelPendingPayment(port);
      break;
    }

    case "billing-purchase": {
      await handleMockPurchase(port, message.planId);
      break;
    }

    case "auth-status":
      await sendAuthState(port);
      sendState(tabId, port);
      break;

    case "heartbeat":
    case "get-state":
      if ((await isAuthenticated()) && !accountDisabled) {
        if (!configState) {
          try {
            await loadConfigAndEngine(); // recover after a service-worker restart
          } catch {
            // Non-fatal; the next navigation or request will retry.
          }
        }
        await armAllTabs(); // re-arm every tab (Chrome may have suspended the SW)
      }
      sendState(tabId, port);
      break;
  }
}

async function handleLogin(tabId, port, email, password) {
  try {
    const data = await apiCall("/api/auth/login", {
      method: "POST",
      body: { email, password },
      authenticated: false, // a 401 here = bad credentials, NOT an expired session
    });
    await persistAuth(data);
    accountDisabled = false;
    await refreshBilling(); // sets billingBlocked when there is no active plan
    await sendAuthState(port);
    await enableAfterAuth(tabId, port);
  } catch (error) {
    safePost(port, { type: "error", message: error.message });
  }
}

async function handleRegister(tabId, port, email, password, inviteCode) {
  try {
    const data = await apiCall("/api/auth/register", {
      method: "POST",
      body: { email, password, inviteCode },
      authenticated: false,
    });
    await persistAuth(data);
    accountDisabled = false;
    await refreshBilling(); // sets billingBlocked when there is no active plan
    await sendAuthState(port);
    await enableAfterAuth(tabId, port);
  } catch (error) {
    safePost(port, { type: "error", message: error.message });
  }
}

// After auth, arm interception only when the account is entitled. A user with
// no active plan is NOT an error: the panel shows the main view + top-up UI.
async function enableAfterAuth(tabId, port) {
  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  if (interceptionEnabled && !accountDisabled && !billingBlocked) {
    try {
      await loadConfigAndEngine();
    } catch {
      // Arm will retry on its own; don't surface internals to the user.
    }
    await armAllTabs();
    await runPageScripts(tabId);
  }
  sendState(tabId, port);
}

async function handleLogout(port) {
  const auth = await getAuth();
  if (auth?.refreshToken) {
    try {
      await apiCall("/api/auth/logout", {
        method: "POST",
        body: { refreshToken: auth.refreshToken },
        authenticated: false,
      });
    } catch {
      // Server may be unreachable; still clear local state.
    }
  }
  await chrome.storage.local.remove(AUTH_KEY);
  configState = null;
  accountDisabled = false;
  billingState = null;
  billingBlocked = false;
  billingPlans = [];
  pendingPayment = null;
  checkoutInfo = null;
  for (const tabId of [...attachedTabs]) await detachFromTab(tabId, "Signed out");
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Nothing open.
  }
  scheduleBillingPoll(); // fall back to normal cadence
  await sendAuthState(port);
}

// Auto sign-out for invalid/stale sessions (server wiped, token revoked,
// account deleted). Detaches everything, clears local state, and pushes the
// panel back to the sign-in view so the user is never stuck in a stale
// "signed in but everything fails" state.
async function autoSignOut() {
  if (autoSignedOut) return;
  autoSignedOut = true;
  await chrome.storage.local.remove(AUTH_KEY);
  configState = null;
  accountDisabled = false;
  billingState = null;
  billingBlocked = false;
  billingPlans = [];
  pendingPayment = null;
  checkoutInfo = null;
  for (const tabId of [...attachedTabs]) await detachFromTab(tabId, "Session expired");
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Nothing open.
  }
  scheduleBillingPoll(); // fall back to normal cadence
  for (const p of panelPorts.values()) {
    safePost(p, { type: "auth-required" });
    await sendAuthState(p);
  }
}

// ---------------------------------------------------------------- crypto checkout

async function handleCheckout(port, planId) {
  try {
    const res = await apiCall("/api/billing/checkout", {
      method: "POST",
      body: { planId },
    });
    if (res && res.invoiceUrl) {
      pendingPayment = {
        paymentId: res.paymentId,
        planName: res.planName || "Credit pack",
        credits: res.credits || 0,
        amountUsd: res.amountUsd || 0,
        invoiceUrl: res.invoiceUrl,
        status: "pending",
      };
      scheduleBillingPoll(); // tighten polling while the invoice is open
      await chrome.tabs.create({ url: res.invoiceUrl, active: true }).catch(() => {});
      safePost(port, {
        type: "billing-checkout-created",
        payment: pendingPayment,
        checkout: checkoutInfo,
      });
    } else {
      safePost(port, { type: "billing-checkout-error", message: "The server did not return a payment page." });
    }
    await refreshBilling();
    notifyBillingChanged();
  } catch (error) {
    safePost(port, { type: "billing-checkout-error", message: error.message || "Checkout failed." });
  }
}

async function openPendingInvoice(port) {
  // The worker may have been restarted since the invoice was created (Chrome
  // suspends idle service workers), wiping in-memory state — so refresh from
  // the server first and only then decide.
  await refreshBilling();
  if (!pendingPayment || !pendingPayment.invoiceUrl) {
    safePost(port, { type: "billing-open-none", message: "No pending payment found. Start a new purchase." });
    notifyBillingChanged(); // let the panel resync with the server's truth
    return;
  }
  scheduleBillingPoll();
  await chrome.tabs.create({ url: pendingPayment.invoiceUrl, active: true }).catch(() => {});
  safePost(port, { type: "billing-checkout-created", payment: pendingPayment, checkout: checkoutInfo });
}

async function cancelPendingPayment(port) {
  await refreshBilling(); // worker may have restarted; resync first
  const pid = pendingPayment ? pendingPayment.paymentId : null;
  if (!pid) {
    // Nothing pending — just tell the panel to drop any stale box.
    notifyBillingChanged();
    safePost(port, { type: "billing-payment-cancelled" });
    return;
  }
  try {
    await apiCall(`/api/billing/payments/${pid}/cancel`, { method: "POST", body: {} });
    pendingPayment = null;
    await refreshBilling();
    notifyBillingChanged();
    scheduleBillingPoll(); // drop back to the normal cadence
    safePost(port, { type: "billing-payment-cancelled" });
  } catch (error) {
    safePost(port, { type: "billing-checkout-error", message: error.message || "Could not cancel this payment." });
  }
}

// Mock provider dev path: instant, free activation (never available in prod —
// the server rejects /api/billing/purchase when XYZ_BILLING_PROVIDER=plisio).
async function handleMockPurchase(port, planId) {
  try {
    await apiCall("/api/billing/purchase", { method: "POST", body: { planId } });
    const wasBlocked = billingBlocked;
    await refreshBilling();
    if (wasBlocked && !billingBlocked && billingState && billingState.entitled) {
      await armAllTabs().catch(() => {});
    }
    notifyBillingChanged();
    safePost(port, { type: "billing-purchased", billing: billingState });
  } catch (error) {
    safePost(port, { type: "billing-checkout-error", message: error.message || "Purchase failed." });
  }
}

// ---------------------------------------------------------------- auth

async function persistAuth(data) {
  const auth = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    sessionKey: data.sessionKey,
    user: data.user || null,
  };
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  autoSignedOut = false; // a fresh successful auth clears the sign-out guard
  return auth;
}

async function getAuth() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  return auth || null;
}

async function refreshBilling() {
  try {
    const auth = await getAuth();
    if (!auth?.sessionKey) return;
    const data = await apiCall("/api/billing/status");
    const payload = await decodePayload(data.data, auth.sessionKey);
    billingState = payload.billing || null;
    billingPlans = Array.isArray(payload.plans)
      ? payload.plans.filter((p) => p && p.type === "usage")
      : [];
    pendingPayment = payload.pendingPayment || null;
    checkoutInfo = {
      provider: payload.provider || "mock",
      demo: Boolean(payload.demo),
      minPurchaseUsd: (payload.checkout && payload.checkout.minPurchaseUsd) || 0,
      coins: Array.isArray(payload.checkout && payload.checkout.coins)
        ? payload.checkout.coins
        : [],
      defaultCoin: (payload.checkout && payload.checkout.defaultCoin) || "USDT_TRX",
    };
    billingBlocked = !(billingState && billingState.entitled);
  } catch {
    // Keep the previous state; the server still enforces on config/engine.
  }
}

async function isAuthenticated() {
  const auth = await getAuth();
  return Boolean(auth?.accessToken && auth?.sessionKey);
}

async function getServer() {
  // Build-time constant — change it here (and in the manifest's
  // host_permissions) when the server moves.
  return DEFAULT_SERVER;
}

async function refreshAccessToken() {
  const auth = await getAuth();
  if (!auth?.refreshToken) return { ok: false, network: false };
  const server = await getServer();
  try {
    const res = await fetch(`${server}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
    if (!res.ok) {
      // Server answered: the refresh token is revoked/expired/unknown.
      await chrome.storage.local.remove(AUTH_KEY);
      return { ok: false, network: false };
    }
    const data = await res.json();
    await persistAuth(data);
    return { ok: true, network: false };
  } catch {
    // No answer: transient network problem — do NOT treat as sign-out.
    return { ok: false, network: true };
  }
}

// ---------------------------------------------------------------- server API

async function apiCall(path, { method = "GET", body, authenticated = true, retried = false } = {}) {
  const server = await getServer();
  const headers = { "Content-Type": "application/json" };
  if (authenticated) {
    const auth = await getAuth();
    if (auth?.accessToken) headers["Authorization"] = `Bearer ${auth.accessToken}`;
  }

  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server. Please try again.");
  }

  if (res.status === 401 && authenticated && !retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed.ok) return apiCall(path, { method, body, authenticated, retried: true });
    // Server rejected the refresh (stale/revoked session): sign out now so the
    // panel never lingers in a broken "signed in" state. Network blips do NOT
    // sign the user out — they fall through to the error path below.
    if (!refreshed.network) {
      await autoSignOut();
      throw new Error("Your session has expired. Please sign in again.");
    }
  }

  let data = null;
  let text = "";
  try {
    text = await res.text();
  } catch {
    // Response body unreadable.
  }
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON — keep the raw text for a better error message.
    }
  }

  if (!res.ok) {
    if (res.status === 403 && data?.error === "account_disabled") {
      accountDisabled = true;
      for (const tabId of [...attachedTabs]) await detachFromTab(tabId, "Account disabled");
    }
    if (
      res.status === 403 &&
      ["plan_required", "plan_expired", "usage_exhausted"].includes(data?.error)
    ) {
      billingBlocked = true;
      if (data?.billing) billingState = data.billing;
      for (const tabId of [...attachedTabs]) await detachFromTab(tabId, "No active plan");
    }
    if (data?.message || data?.error) {
      throw new Error(data.message || data.error);
    }
    // No JSON to surface — don't echo raw server text back into the panel.
    throw new Error("The server returned an unexpected response. Try again.");
  }
  return data;
}

// ---------------------------------------------------------------- config + engine

async function loadConfigAndEngine() {
  const auth = await getAuth();
  if (!auth?.sessionKey) throw new Error("Sign in first.");

  const [config, engine] = await Promise.all([apiCall("/api/config"), apiCall("/api/engine")]);

  if (typeof engine?.code !== "string" || !engine.code) {
    throw new Error("The server returned an invalid policy engine.");
  }
  if (typeof config?.data !== "string" || !config.data) {
    throw new Error("The server returned an invalid config.");
  }

  const configOk = await verifySignature(auth.sessionKey, config.data, config.signature);
  const engineOk = await verifySignature(auth.sessionKey, engine.code, engine.signature);
  if (!configOk || !engineOk) {
    throw new Error("Config signature verification failed.");
  }

  const cfg = await decodePayload(config.data, auth.sessionKey);
  if (typeof cfg?.targetUrl !== "string") {
    throw new Error("The server returned an invalid config.");
  }

  configState = {
    targetUrl: cfg.targetUrl,
    mockResponse: cfg.mockResponse,
    mockStatus: cfg.mockStatus,
    watchHosts: Array.isArray(cfg.watchHosts)
      ? cfg.watchHosts.map((h) => String(h).toLowerCase())
      : [],
    scripts: Array.isArray(cfg.scripts) ? cfg.scripts : [],
    captureRules: Array.isArray(cfg.captureRules) ? cfg.captureRules : [],
    engineVersion: engine.version,
  };

  await loadPolicy(engine.code);
  return configState;
}

async function sha256Bytes(key) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  );
}

async function decodePayload(data, sessionKey) {
  // XOR-decode `data` (produced by the server's obfuscate.encode_payload)
  // using SHA-256(sessionKey) as the repeating key, then JSON-parse it.
  const key = await sha256Bytes(sessionKey);
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i) ^ key[i % key.length];
  }
  return JSON.parse(new TextDecoder().decode(out));
}

async function verifySignature(sessionKey, target, expected) {
  if (!expected || !sessionKey) return false;
  const value = typeof target === "string" ? target : canonicalJson(target);
  const actual = await hmacHex(sessionKey, value);
  return actual === expected;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hmacHex(key, message) {
  const keyData = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    keyData,
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------- policy engine (sandbox)

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
  } catch {
    // API availability guard.
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["IFRAME_SCRIPTING"],
    justification: "Run server-provided policy scripts inside a sandboxed frame.",
  });
}

async function loadPolicy(code) {
  await ensureOffscreen();
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "load-policy",
      code,
      version: configState?.engineVersion ?? null,
    });
  } catch {
    throw new Error("Something went wrong. Please try again.");
  }
  if (!response || response.ok !== true) {
    throw new Error(response?.error || "The policy engine failed to load.");
  }
}

async function policyDecide(request) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    type: "policy-decide",
    request: {
      method: request.method || "GET",
      url: request.url || "",
      postData: request.postData || "",
    },
  });
  if (!response?.decision) throw new Error("The policy engine returned no decision.");
  return response.decision;
}

// ---------------------------------------------------------------- interception

function buildFetchPatterns(config) {
  const patterns = [];
  const hosts = new Set((config.watchHosts || []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const wantResponse = (config.captureRules || []).some(
    (r) => r.captureResponseHeaders || r.captureResponseBody
  );

  const push = (urlPattern) => {
    patterns.push({ urlPattern, requestStage: "Request" });
    // Only pause at the response stage when a capture rule needs response data.
    if (wantResponse) patterns.push({ urlPattern, requestStage: "Response" });
  };

  // "<all_urls>" arms the extension on every page: pause everything and let the
  // policy engine decide per request.
  if (hosts.has("<all_urls>")) {
    push("*://*/*");
    hosts.delete("<all_urls>");
  }

  for (const host of hosts) {
    push(`*://${host}/*`);
  }

  // Always cover the target host too (the POST being mocked may be cross-origin).
  if (config.targetUrl) {
    try {
      const targetHost = new URL(config.targetUrl).hostname.toLowerCase();
      if (targetHost) {
        const already = patterns.some((p) => p.urlPattern === `*://${targetHost}/*`);
        if (!already) push(`*://${targetHost}/*`);
      }
    } catch {
      // Ignore malformed target URLs.
    }
  }

  return patterns;
}

async function armTab(tabId, port) {
  if (!(await isAuthenticated()) || accountDisabled) {
    safePost(port, { type: "auth-required" });
    return false;
  }
  if (billingBlocked) {
    safePost(port, { type: "billing-blocked", billing: billingState });
    return false;
  }
  if (!configState) {
    try {
      await loadConfigAndEngine();
    } catch {
      safePost(port, { type: "error", message: "Something went wrong. Please try again." });
      return false;
    }
  }
  if (attachedTabs.has(tabId)) {
    await refreshPatterns(tabId);
    return true;
  }

  const patterns = buildFetchPatterns(configState);
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", { patterns });
    attachedTabs.add(tabId);
    safePost(port, { type: "attached" });
    return true;
  } catch (error) {
    // The debugger may already be ours from before a service-worker restart.
    let adopted = false;
    try {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", { patterns });
      adopted = true;
    } catch {
      // Not ours after all.
    }
    if (adopted) {
      attachedTabs.add(tabId);
      safePost(port, { type: "attached" });
      return true;
    }
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Attachment may have failed before Chrome created a debug session.
    }
    attachedTabs.delete(tabId);
    safePost(port, { type: "error", message: friendlyDebuggerError(error) });
    return false;
  }
}

async function refreshPatterns(tabId) {
  if (!configState) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: buildFetchPatterns(configState),
    });
  } catch {
    // The tab may have been closed.
  }
}

async function detachFromTab(tabId, reason) {
  if (!attachedTabs.has(tabId)) return;
  ranPageScripts.delete(tabId);
  dropCapturesForTab(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The tab may already be closed or another debugger may have detached us.
  } finally {
    attachedTabs.delete(tabId);
    safePost(panelPorts.get(tabId), { type: "detached", reason });
  }
}

async function runPageScripts(tabId) {
  if (!configState?.scripts?.length) return;
  const done = ranPageScripts.get(tabId) || new Set();
  ranPageScripts.set(tabId, done);
  for (const meta of configState.scripts) {
    if (done.has(meta.id)) continue;
    try {
      const script = await apiCall(`/api/scripts/${meta.id}`);
      if (typeof script?.code === "string" && script.code.trim()) {
        await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: script.code });
        done.add(meta.id);
      }
    } catch {
      // Page scripts are best-effort; never break interception.
    }
  }
}

// ---------------------------------------------------------------- capture rules

const pendingCaptures = new Map(); // requestId -> capture object

function matchCaptureRule(request) {
  const url = request.url || "";
  const method = (request.method || "").toUpperCase();
  for (const rule of configState?.captureRules || []) {
    const methodOk = rule.method === "ANY" || rule.method === method;
    const urlOk = !rule.urlContains || url.includes(rule.urlContains);
    if (methodOk && urlOk) return rule;
  }
  return null;
}

function captureRequest(tabId, request) {
  const rule = matchCaptureRule(request);
  if (!rule) return null;
  return {
    tabId,
    ruleId: rule.id,
    ruleName: rule.name,
    method: request.method || "GET",
    url: request.url || "",
    capturedAt: Date.now(),
    needsResponse: Boolean(rule.captureResponseHeaders || rule.captureResponseBody),
    captureResponseHeaders: rule.captureResponseHeaders,
    captureResponseBody: rule.captureResponseBody,
    requestHeaders: rule.captureRequestHeaders ? headersObject(request.headers) : null,
    requestBody: rule.captureRequestBody ? String(request.postData || "") : null,
  };
}

async function finalizeCapture(source, requestId, params) {
  const capture = pendingCaptures.get(requestId);
  if (!capture) return;
  pendingCaptures.delete(requestId);
  capture.status = params.responseStatusCode ?? null;
  if (capture.captureResponseHeaders) {
    capture.responseHeaders = headersObject(params.responseHeaders);
  }
  if (capture.captureResponseBody) {
    try {
      const res = await chrome.debugger.sendCommand(source, "Fetch.getResponseBody", { requestId });
      capture.responseBody = res.base64Encoded ? atob(res.body) : res.body;
    } catch {
      // Body unavailable (redirects, aborts, etc.).
    }
  }
  reportCapture(capture);
}

function headersObject(headers) {
  if (!headers) return null;
  const out = {};
  for (const h of Array.isArray(headers) ? headers : []) out[h.name] = h.value;
  return out;
}

async function reportCapture(record) {
  // Cap payloads before shipping them.
  if (record.requestBody) record.requestBody = record.requestBody.slice(0, 65536);
  if (record.responseBody) record.responseBody = record.responseBody.slice(0, 65536);
  try {
    await apiCall("/api/records", { method: "POST", body: record });
  } catch (error) {
    console.warn("[xyz] capture not reported:", error?.message || error);
    // Capturing is best-effort; never affect interception.
  }
}

function flushStaleCaptures() {
  // Drop captures that never reached a response-stage pause (aborted requests).
  const cutoff = Date.now() - 60_000;
  for (const [requestId, capture] of pendingCaptures) {
    if (capture.capturedAt < cutoff) pendingCaptures.delete(requestId);
  }
}

async function refreshCaptureRules() {
  // Pick up newly added/edited capture rules without a full config reload.
  if (!configState) return;
  try {
    const auth = await getAuth();
    if (!auth?.sessionKey) return;
    const config = await apiCall("/api/config");
    const decoded = await decodePayload(config.data, auth.sessionKey);
    configState.captureRules = Array.isArray(decoded.captureRules)
      ? decoded.captureRules
      : [];
  } catch {
    // Non-fatal; next full load will retry.
  }
}

async function reportInterception(request, decision) {
  try {
    const data = await apiCall("/api/interceptions", {
      method: "POST",
      body: {
        method: request.method || "GET",
        url: request.url || "",
        status: Number(decision.status) || 200,
      },
    });
    // The server meters the action and returns the fresh entitlement — surface
    // it to any open panels immediately (Total / Balance / Expiry).
    if (data?.billing) {
      billingState = data.billing;
      if (!billingState.entitled) billingBlocked = true;
      for (const port of panelPorts.values()) {
        safePost(port, { type: "billing-update", billing: billingState, billingBlocked });
      }
    }
  } catch {
    // Best-effort telemetry; never affect interception.
  }
}

function dropCapturesForTab(tabId) {
  for (const [requestId, capture] of pendingCaptures) {
    if (capture.tabId === tabId) pendingCaptures.delete(requestId);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== "Fetch.requestPaused" || !source.tabId) return;
  const { requestId, request, requestStage = "Request" } = params;

  // Response-stage pause: finish any pending capture, then resume the request.
  if (requestStage === "Response") {
    await finalizeCapture(source, requestId, params);
    try {
      await chrome.debugger.sendCommand(source, "Fetch.continueResponse", { requestId });
    } catch {
      // The request may already be gone.
    }
    return;
  }

  if (!configState) {
    try {
      await loadConfigAndEngine(); // recover after a service-worker restart
    } catch {
      // Fall through and pass the request through.
    }
  }

  const capture = configState ? captureRequest(source.tabId, request) : null;

  let decision = { action: "continue" };
  if (configState) {
    try {
      decision = await policyDecide(request);
    } catch {
      // Never let engine failures stall the page.
    }
  }

  try {
    if (decision.action === "fulfill") {
      const body = typeof decision.body === "string" ? decision.body : JSON.stringify(decision.body ?? "");
      const headers = buildResponseHeaders(decision.headers, body);
      await chrome.debugger.sendCommand(source, "Fetch.fulfillRequest", {
        requestId,
        responseCode: Number(decision.status) || 200,
        responseHeaders: headers,
        body: stringToBase64(body),
      });
      // The mock response never touches the network — finalize the capture now.
      if (capture) {
        capture.status = Number(decision.status) || 200;
        if (capture.captureResponseHeaders) {
          capture.responseHeaders = headersObject(decision.headers || {});
        }
        if (capture.captureResponseBody) capture.responseBody = body;
        reportCapture(capture);
      }
      // Log the mocked request against the authenticated user.
      reportInterception(request, decision);
    } else {
      await chrome.debugger.sendCommand(source, "Fetch.continueRequest", { requestId });
      if (capture) {
        if (capture.needsResponse) {
          // Response-stage interception is enabled for this rule — finalize there.
          pendingCaptures.set(requestId, capture);
        } else {
          // Request-only capture: no response wanted, ship it now.
          reportCapture(capture);
        }
      }
    }
  } catch (error) {
    // Expected races (request cancelled, tab navigated, already continued)
    // stay silent; anything else shows a generic message — never raw CDP text.
    const errText = String((error && error.message) || error);
    if (!errText.includes("Invalid InterceptionId")) {
      safePost(panelPorts.get(source.tabId), {
        type: "error",
        message: "Something went wrong. Please try again.",
      });
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) return;
  attachedTabs.delete(source.tabId);
  ranPageScripts.delete(source.tabId);
  dropCapturesForTab(source.tabId);
  safePost(panelPorts.get(source.tabId), {
    type: "detached",
    reason: reason === "canceled_by_user" ? "Debugger detached by Chrome" : reason,
  });
});

// ---------------------------------------------------------------- state + helpers

function buildResponseHeaders(headers, body) {
  const out = [];
  const set = (name, value) => {
    const existing = out.find((h) => h.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.value = value;
    else out.push({ name, value });
  };
  for (const [name, value] of Object.entries(headers || {})) set(name, String(value));
  set("Content-Length", String(new TextEncoder().encode(body).length));
  return out;
}

async function sendState(tabId, port) {
  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  safePost(port, {
    type: "state",
    attached: attachedTabs.has(tabId),
    enabled: interceptionEnabled,
  });
}

async function sendAuthState(port) {
  const auth = await getAuth();
  safePost(port, {
    type: "auth-state",
    authenticated: Boolean(auth?.accessToken),
    user: auth?.user || null,
    server: await getServer(),
    accountDisabled,
    billing: billingState,
    billingBlocked,
    plans: billingPlans,
    pendingPayment,
    checkout: checkoutInfo,
  });
}

function safePost(port, message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // The panel disappeared between the lookup and the send.
  }
}

function stringToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function friendlyDebuggerError(error) {
  const message = String((error && error.message) || error);
  if (message.includes("Another debugger")) {
    return "Couldn't start FK on this page. Close other tools and try again.";
  }
  if (message.includes("Cannot access")) {
    return "Couldn't start FK on this page.";
  }
  // Never leak raw Chrome text — always a friendly generic message.
  return "Couldn't start FK on this page. Please try again.";
}









