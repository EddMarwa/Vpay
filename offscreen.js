// Relay between the service worker and the sandboxed policy iframe.
const iframe = document.getElementById("sandbox");
let pendingResolve = null;
let sandboxReady = false;
const readyQueue = [];

window.addEventListener("message", (event) => {
  if (event.source !== iframe.contentWindow) return;
  const data = event.data || {};
  if (data.type === "sandbox-ready") {
    sandboxReady = true;
    for (const job of readyQueue) {
      deliver(job.message, job.sendResponse);
    }
    readyQueue.length = 0;
    return;
  }
  if (data.type === "policy-ready" || data.type === "policy-decision") {
    const resolve = pendingResolve;
    pendingResolve = null;
    if (resolve) resolve(data);
  }
});

function deliver(message, sendResponse) {
  if (pendingResolve) {
    pendingResolve(null);
    pendingResolve = null;
  }
  pendingResolve = sendResponse;
  iframe.contentWindow.postMessage(
    message.type === "load-policy"
      ? { type: "load-policy", code: message.code, version: message.version }
      : { type: "policy-decide", request: message.request },
    "*"
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "ping") {
    sendResponse({ type: "pong" });
    return;
  }
  if (message.type !== "load-policy" && message.type !== "policy-decide") return;

  if (!sandboxReady) {
    readyQueue.push({ message, sendResponse });
    return;
  }
  deliver(message, sendResponse);
  return true; // async sendResponse
});
