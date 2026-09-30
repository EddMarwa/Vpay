import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("usage and records API", () => {
  it("meters an entitled interception and stores a capture record", async () => {
    const registerResponse = await SELF.fetch("https://vpay.workers.dev/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `usage-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple" }),
    });
    const auth = await registerResponse.json<{ accessToken: string; user: { id: string } }>();
    await env.vpay_db.prepare(
      `INSERT INTO billing_accounts (user_id, plan_name, plan_type, credits_remaining, entitled)
       VALUES (?, 'Test plan', 'usage', 2, 1)`,
    ).bind(auth.user.id).run();

    const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
    const interceptionResponse = await SELF.fetch("https://vpay.workers.dev/api/interceptions", {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "POST", url: "https://example.com/api", status: 200 }),
    });
    const interception = await interceptionResponse.json<{ billing: { creditsRemaining: number; used: number } }>();
    expect(interceptionResponse.status).toBe(200);
    expect(interception.billing.creditsRemaining).toBe(1);
    expect(interception.billing.used).toBe(1);

    const recordResponse = await SELF.fetch("https://vpay.workers.dev/api/records", {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "POST", url: "https://example.com/api", status: 200, requestBody: "payload" }),
    });
    expect(recordResponse.status).toBe(200);

    const stored = await env.vpay_db.prepare("SELECT request_body FROM records WHERE user_id = ?").bind(auth.user.id).first<{ request_body: string }>();
    expect(stored?.request_body).toBe("payload");
  });

  it("blocks interception without an active plan", async () => {
    const registerResponse = await SELF.fetch("https://vpay.workers.dev/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `blocked-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple" }),
    });
    const auth = await registerResponse.json<{ accessToken: string }>();
    const response = await SELF.fetch("https://vpay.workers.dev/api/interceptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "GET", url: "https://example.com", status: 200 }),
    });
    expect(response.status).toBe(403);
    expect((await response.json<{ error: string }>()).error).toBe("plan_required");
  });
});
