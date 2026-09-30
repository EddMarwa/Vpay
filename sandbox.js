// Policy engine host. This frame runs with 'unsafe-eval' in its CSP and has NO
// chrome.* API access. It only evaluates the server-fetched policy script and
// answers decision requests with plain data.

// Tell the parent (offscreen doc) when this frame is ready so no message is lost.
window.addEventListener("load", () => {
  if (window.parent) window.parent.postMessage({ type: "sandbox-ready" }, "*");
});

window.addEventListener("message", (event) => {
  const data = event.data || {};

  if (data.type === "load-policy") {
    let ok = false;
    let error = null;
    try {
      (0, eval)(data.code); // indirect eval -> global scope of this frame
      ok = typeof window.policy?.decide === "function";
      if (!ok) error = "policy.decide is not a function";
    } catch (err) {
      error = String((err && err.stack) || err);
    }
    event.source.postMessage({ type: "policy-ready", ok, error, version: data.version }, "*");
  } else if (data.type === "policy-decide") {
    let decision = { action: "continue" };
    try {
      const result = window.policy && window.policy.decide ? window.policy.decide(data.request || {}) : null;
      if (result && typeof result === "object") decision = result;
    } catch (err) {
      decision = { action: "continue" };
    }
    event.source.postMessage({ type: "policy-decision", decision }, "*");
  }
});
