import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("protected policy API", () => {
  it("returns signed config and engine data for an authenticated user", async () => {
    const registerResponse = await SELF.fetch("https://vpay.workers.dev/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `policy-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple" }),
    });
    const auth = await registerResponse.json<{ accessToken: string }>();

    const configResponse = await SELF.fetch("https://vpay.workers.dev/api/config", {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    const config = await configResponse.json<{ data: string; signature: string }>();
    expect(configResponse.status).toBe(200);
    expect(config.data).toBeTruthy();
    expect(config.signature).toMatch(/^[a-f0-9]{64}$/);

    const engineResponse = await SELF.fetch("https://vpay.workers.dev/api/engine", {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    const engine = await engineResponse.json<{ code: string; version: string; signature: string }>();
    expect(engineResponse.status).toBe(200);
    expect(engine.code).toContain("window.policy");
    expect(engine.version).toBe("1.0.0");
    expect(engine.signature).toMatch(/^[a-f0-9]{64}$/);
  });
});