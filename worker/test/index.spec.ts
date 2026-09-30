import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("API Worker base behavior", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    const response = await SELF.fetch("https://vpay.workers.dev/unknown");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", message: "Route not found." });
  });

  it("handles CORS preflight requests", async () => {
    const response = await SELF.fetch("https://vpay.workers.dev/api/auth/login", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
