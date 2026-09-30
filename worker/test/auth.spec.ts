import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const email = `auth-${crypto.randomUUID()}@example.com`;
const password = "correct horse battery staple";

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://vpay.workers.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("authentication API", () => {
  it("registers an account and returns session tokens", async () => {
    const response = await post("/api/auth/register", { email, password });
    const body = await response.json<{ user: { email: string }; accessToken: string; refreshToken: string; sessionKey: string }>();

    expect(response.status).toBe(201);
    expect(body.user.email).toBe(email);
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.sessionKey).toBeTruthy();
  });

  it("rejects duplicate email registration", async () => {
    const response = await post("/api/auth/register", { email, password });
    expect(response.status).toBe(409);
  });

  it("logs in, refreshes, and revokes a session", async () => {
    const loginResponse = await post("/api/auth/login", { email, password });
    const loginBody = await loginResponse.json<{ refreshToken: string; accessToken: string }>();
    expect(loginResponse.status).toBe(200);

    const refreshResponse = await post("/api/auth/refresh", { refreshToken: loginBody.refreshToken });
    const refreshBody = await refreshResponse.json<{ accessToken: string }>();
    expect(refreshResponse.status).toBe(200);
    expect(refreshBody.accessToken).not.toBe(loginBody.accessToken);

    const logoutResponse = await post("/api/auth/logout", { refreshToken: loginBody.refreshToken });
    expect(logoutResponse.status).toBe(200);

    const revokedRefreshResponse = await post("/api/auth/refresh", { refreshToken: loginBody.refreshToken });
    expect(revokedRefreshResponse.status).toBe(401);
  });
});
