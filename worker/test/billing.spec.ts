import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { billingEntitled } from "../src/billing";

async function createAccount() {
  const response = await SELF.fetch("https://vpay.workers.dev/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `billing-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple" }),
  });
  return response.json<{ accessToken: string; user: { id: string } }>();
}

async function createPlan() {
  const result = await env.vpay_db.prepare(
    "INSERT INTO plans (name, type, credits, price_cents, active) VALUES ('Starter', 'usage', 10, 500, 1)",
  ).run();
  return Number(result.meta.last_row_id);
}

describe("billing API", () => {
  it("treats SQLite datetime strings as valid future expirations", () => {
    expect(billingEntitled(1, "2099-01-01 12:00:00")).toBe(true);
    expect(billingEntitled(1, "2020-01-01 12:00:00")).toBe(false);
    expect(billingEntitled(1, "2999-01-01T12:00:00.000Z")).toBe(true);
    expect(billingEntitled(0, "2099-01-01 12:00:00")).toBe(false);
  });

  it("returns signed status and fulfills a local mock purchase", async () => {
    const auth = await createAccount();
    const planId = await createPlan();
    const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };

    const statusResponse = await SELF.fetch("https://vpay.workers.dev/api/billing/status", { headers });
    const statusBody = await statusResponse.json<{ data: string; signature: string }>();
    expect(statusResponse.status).toBe(200);
    expect(statusBody.data).toBeTruthy();
    expect(statusBody.signature).toMatch(/^[a-f0-9]{64}$/);

    const purchaseResponse = await SELF.fetch("https://vpay.workers.dev/api/billing/purchase", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId }),
    });
    expect(purchaseResponse.status).toBe(200);
    const account = await env.vpay_db.prepare("SELECT credits_remaining FROM billing_accounts WHERE user_id = ?").bind(auth.user.id).first<{ credits_remaining: number }>();
    expect(account?.credits_remaining).toBe(10);
  });

  it("creates and cancels a pending checkout", async () => {
    const auth = await createAccount();
    const planId = await createPlan();
    const headers = { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" };
    const checkoutResponse = await SELF.fetch("https://vpay.workers.dev/api/billing/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId }),
    });
    const checkout = await checkoutResponse.json<{ paymentId: string; invoiceUrl: string; status: string }>();
    expect(checkoutResponse.status).toBe(200);
    expect(checkout.invoiceUrl).toContain("example.invalid");
    expect(checkout.status).toBe("pending");

    const cancelResponse = await SELF.fetch(`https://vpay.workers.dev/api/billing/payments/${checkout.paymentId}/cancel`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(cancelResponse.status).toBe(200);
    const payment = await env.vpay_db.prepare("SELECT status FROM payments WHERE id = ?").bind(checkout.paymentId).first<{ status: string }>();
    expect(payment?.status).toBe("cancelled");
  });
});
