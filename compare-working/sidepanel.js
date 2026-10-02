const enabledToggle = document.querySelector("#enabledToggle");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const statusDetail = document.querySelector("#statusDetail");
const errorBox = document.querySelector("#errorBox");
const accountEmail = document.querySelector("#accountEmail");
const captureTotal = document.querySelector("#captureTotal");
const captureMatched = document.querySelector("#captureMatched");
const captureStatus = document.querySelector("#captureStatus");
const exportBtn = document.querySelector("#exportBtn");
const clearBtn = document.querySelector("#clearBtn");
const exportResult = document.querySelector("#exportResult");

let port;
let heartbeat;
let panelTabId = null;
let reconnectAttempts = 0;

start();

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    if (enabledToggle) enabledToggle.disabled = true;
    return;
  }
  panelTabId = tab.id;

  const { interceptionEnabled = true } = await chrome.storage.local.get("interceptionEnabled");
  if (enabledToggle) enabledToggle.checked = interceptionEnabled;

  port = chrome.runtime.connect({ name: `fk-panel:${panelTabId}` });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);

  heartbeat = setInterval(() => safeSend({ type: "heartbeat" }), 3000);
  safeSend({ type: "get-state" });
}

function handleDisconnect() {
  clearInterval(heartbeat);
  heartbeat = null;
  port = null;
  
  if (document.hidden || reconnectAttempts >= 10) {
    setStatus(false, "Disconnected", "Connection lost.");
    return;
  }
  
  reconnectAttempts += 1;
  setTimeout(() => {
    start().then(() => { reconnectAttempts = 0; }).catch(() => {});
  }, 1500);
}

if (enabledToggle) {
  enabledToggle.addEventListener("change", () => {
    hideError();
    setStatus(false, enabledToggle.checked ? "Activating..." : "Turning off...", "Updating...");
    safeSend({ type: "set-enabled", enabled: enabledToggle.checked });
  });
}

if (exportBtn) {
  exportBtn.addEventListener("click", () => {
    if (exportResult) exportResult.textContent = "Exporting...";
    safeSend({ type: "export-captures" });
  });
}

if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    safeSend({ type: "clear-captures" });
    if (exportResult) exportResult.textContent = "Cleared!";
  });
}

function handleMessage(message) {
  switch (message.type) {
    case "auth-state":
      if (message.user && accountEmail) {
        accountEmail.textContent = message.user.email || "local";
      }
      break;
      
    case "attached":
      if (enabledToggle) enabledToggle.checked = true;
      setStatus(true, "Active", "FAFSA fraud check bypass active");
      hideError();
      break;
      
    case "state":
      if (typeof message.enabled === "boolean" && enabledToggle) {
        enabledToggle.checked = message.enabled;
      }
      setStatus(
        message.attached,
        message.attached ? "Active" : "Inactive",
        message.attached ? "Bypass active" : "FK is off."
      );
      break;
      
    case "detached":
      setStatus(false, "Inactive", message.reason || "FK is off.");
      break;
      
    case "error":
      setStatus(false, "Error", "Something went wrong.");
      showError(message.message);
      break;

    case "capture-stats":
      if (captureTotal) captureTotal.textContent = message.stats.total;
      if (captureMatched) captureMatched.textContent = message.stats.matched;
      if (captureStatus) {
        captureStatus.textContent = message.stats.matched > 0 ? "BLOCKING!" : "Ready";
        captureStatus.style.color = message.stats.matched > 0 ? "#52e4b4" : "#8f99ac";
      }
      break;

    case "export-result":
      if (exportResult) {
        exportResult.textContent = message.result.success 
          ? "✓ " + message.result.message 
          : "✗ " + message.result.message;
      }
      break;
  }
}

function setStatus(active, title, detail) {
  if (statusDot) statusDot.classList.toggle("active", active);
  if (statusText) statusText.textContent = title;
  if (statusDetail) statusDetail.textContent = detail;
}

function showError(message) {
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
}

function hideError() {
  if (errorBox) errorBox.hidden = true;
}

function safeSend(message) {
  try {
    port?.postMessage(message);
  } catch {}
}