import type { AuthUser } from "./auth";
import { encodePayload, hmacHex, sessionKeyFor } from "./policy";

type BillingEnv = Env & {
  PAYMENT_PROVIDER?: string;
  PLISIO_API_KEY?: string;
  PLISIO_DEFAULT_COIN?: string;
  PUBLIC_API_URL?: string;
};

type PlanRow = {
  id: number;
  name: string;
  type: string;
  credits: number;
  price_cents: number;
  active: number;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function provider(env: BillingEnv): string {
  return env.PAYMENT_PROVIDER || "unconfigured";
}

async function getPlan(env: Env, planId: unknown): Promise<PlanRow | null> {
  const id = Number(planId);
  if (!Number.isInteger(id) || id < 1) return null;
  return env.vpay_db.prepare(
    "SELECT id, name, type, credits, price_cents, active FROM plans WHERE id = ? AND active = 1",
  ).bind(id).first<PlanRow>();
}

async function billingRow(env: Env, userId: string) {
  return env.vpay_db.prepare(
    `SELECT plan_name, plan_type, credits_remaining, used, expires_at, entitled
     FROM billing_accounts WHERE user_id = ?`,
  ).bind(userId).first<{
    plan_name: string | null;
    plan_type: string | null;
    credits_remaining: number;
    used: number;
    expires_at: string | null;
    entitled: number;
  }>();
}

function billingPayload(row: Awaited<ReturnType<typeof billingRow>>) {
  if (!row) return null;
  return {
    planName: row.plan_name,
    planType: row.plan_type,
    creditsRemaining: row.credits_remaining,
    used: row.used,
    expiresAt: row.expires_at,
    entitled: Boolean(row.entitled) && (!row.expires_at || row.expires_at > new Date().toISOString()),
  };
}

async function signedStatus(request: Request, env: BillingEnv, user: AuthUser, payload: unknown): Promise<Response> {
  const sessionKey = await sessionKeyFor(user, env, request);
  if (!sessionKey) return json({ error: "invalid_session", message: "Your session has expired." }, 401);
  const data = await encodePayload(payload, sessionKey);
  return json({ data, signature: await hmacHex(sessionKey, data) });
}

export async function status(request: Request, env: BillingEnv, user: AuthUser): Promise<Response> {
  const plans = await env.vpay_db.prepare(
    "SELECT id, name, type, credits, price_cents, active FROM plans WHERE active = 1 ORDER BY price_cents ASC, id ASC",
  ).all<PlanRow>();
  const pending = await env.vpay_db.prepare(
    `SELECT id, plan_id, status, amount_usd, credits, invoice_url, wallet_address, wallet_currency, wallet_amount, created_at
     FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
  ).bind(user.id).first<{
    id: string;
    plan_id: number;
    status: string;
    amount_usd: number;
    credits: number;
    invoice_url: string | null;
    wallet_address: string | null;
    wallet_currency: string | null;
    wallet_amount: string | null;
    created_at: string;
  }>();
  const plan = pending ? await getPlan(env, pending.plan_id) : null;
  return signedStatus(request, env, user, {
    billing: billingPayload(await billingRow(env, user.id)),
    plans: plans.results,
    pendingPayment: pending ? {
      paymentId: pending.id,
      planName: plan?.name || "Credit pack",
      credits: pending.credits,
      amountUsd: pending.amount_usd,
      invoiceUrl: pending.invoice_url,
      walletAddress: pending.wallet_address,
      walletCurrency: pending.wallet_currency,
      walletAmount: pending.wallet_amount,
      status: pending.status,
    } : null,
    provider: provider(env),
    demo: provider(env) === "mock",
    checkout: { minPurchaseUsd: provider(env) === "plisio" ? 1 : 0, coins: ["USDT_TRX"], defaultCoin: "USDT_TRX" },
  });
}

export async function purchase(env: BillingEnv, user: AuthUser, body: Record<string, unknown>): Promise<Response> {
  if (provider(env) !== "mock") return json({ error: "provider_checkout_required", message: "Crypto purchases must use checkout." }, 409);
  const plan = await getPlan(env, body.planId);
  if (!plan || plan.type !== "usage") return json({ error: "invalid_plan", message: "Credit plan not found." }, 400);
  const paymentId = crypto.randomUUID();
  await env.vpay_db.batch([
    env.vpay_db.prepare(
      `INSERT INTO payments (id, user_id, plan_id, provider, status, amount_usd, credits, paid_at)
       VALUES (?, ?, ?, 'mock', 'paid', ?, ?, datetime('now'))`,
    ).bind(paymentId, user.id, plan.id, plan.price_cents / 100, plan.credits),
    env.vpay_db.prepare(
      `INSERT INTO billing_accounts (user_id, plan_id, plan_name, plan_type, credits_remaining, entitled)
       VALUES (?, ?, ?, 'usage', ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, plan_name = excluded.plan_name,
       plan_type = excluded.plan_type, credits_remaining = billing_accounts.credits_remaining + excluded.credits_remaining,
       entitled = 1, updated_at = datetime('now')`,
    ).bind(user.id, plan.id, plan.name, plan.credits),
  ]);
  return json({ ok: true, paymentId, billing: billingPayload(await billingRow(env, user.id)) });
}

export async function checkout(env: BillingEnv, user: AuthUser, body: Record<string, unknown>): Promise<Response> {
  const plan = await getPlan(env, body.planId);
  if (!plan || plan.type !== "usage") return json({ error: "invalid_plan", message: "Credit plan not found." }, 400);
  if (provider(env) === "unconfigured" || (provider(env) === "plisio" && !env.PLISIO_API_KEY)) {
    return json({ error: "payment_provider_not_configured", message: "Crypto payments are not configured yet." }, 503);
  }
  const paymentId = crypto.randomUUID();
  await env.vpay_db.prepare(
    `INSERT INTO payments (id, user_id, plan_id, provider, status, amount_usd, credits, invoice_url)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(paymentId, user.id, plan.id, provider(env), plan.price_cents / 100, plan.credits, provider(env) === "mock" ? `https://example.invalid/vpay-demo-payment/${paymentId}` : null).run();
  if (provider(env) === "mock") {
    return json({ paymentId, planName: plan.name, credits: plan.credits, amountUsd: plan.price_cents / 100, invoiceUrl: `https://example.invalid/vpay-demo-payment/${paymentId}`, status: "pending" });
  }

  const callbackBase = env.PUBLIC_API_URL || "https://vpay.workers.dev";
  const query = new URLSearchParams({
    api_key: env.PLISIO_API_KEY!,
    source_currency: "USD",
    source_amount: (plan.price_cents / 100).toFixed(2),
    order_number: paymentId,
    order_name: plan.name,
    currency: env.PLISIO_DEFAULT_COIN || "USDT_TRX",
    email: user.email,
    callback_url: `${callbackBase}/api/billing/plisio/callback?json=true`,
  });
  let response: Response;
  try {
    response = await fetch(`https://api.plisio.net/api/v1/invoices/new?${query.toString()}`);
  } catch {
    await env.vpay_db.prepare("UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(paymentId).run();
    return json({ error: "payment_provider_unreachable", message: "The payment provider could not be reached." }, 502);
  }
  let result: { status?: string; data?: { txn_id?: string; invoice_url?: string; wallet_hash?: string; psys_cid?: string; currency?: string; amount?: string } } | null = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok || result?.status !== "success" || !result.data?.txn_id || !result.data.invoice_url) {
    await env.vpay_db.prepare("UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(paymentId).run();
    return json({ error: "payment_provider_error", message: "The payment provider rejected the invoice request." }, 502);
  }
  await env.vpay_db.prepare(
    `UPDATE payments SET provider_payment_id = ?, invoice_url = ?, wallet_address = ?, wallet_currency = ?, wallet_amount = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  ).bind(result.data.txn_id, result.data.invoice_url, result.data.wallet_hash || null, result.data.psys_cid || result.data.currency || null, result.data.amount || null, paymentId).run();
  return json({ paymentId, planName: plan.name, credits: plan.credits, amountUsd: plan.price_cents / 100, invoiceUrl: result.data.invoice_url, walletAddress: result.data.wallet_hash || null, walletCurrency: result.data.psys_cid || result.data.currency || null, walletAmount: result.data.amount || null, status: "pending" });
}

export async function cancel(env: BillingEnv, user: AuthUser, paymentId: string): Promise<Response> {
  const result = await env.vpay_db.prepare(
    "UPDATE payments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending'",
  ).bind(paymentId, user.id).run();
  if (result.meta.changes !== 1) return json({ error: "payment_not_found", message: "Pending payment not found." }, 404);
  return json({ ok: true });
}

function canonicalCallbackData(body: Record<string, unknown>): string {
  const ordered = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "verify_hash").sort(([left], [right]) => left.localeCompare(right)));
  if (ordered.expire_utc !== undefined) ordered.expire_utc = String(ordered.expire_utc);
  if (typeof ordered.tx_urls === "string") ordered.tx_urls = ordered.tx_urls.replaceAll("&quot;", '"');
  return JSON.stringify(ordered);
}

async function verifyPlisioCallback(body: Record<string, unknown>, secret: string): Promise<boolean> {
  if (typeof body.verify_hash !== "string") return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalCallbackData(body))));
  const expected = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== body.verify_hash.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ body.verify_hash.charCodeAt(index);
  return difference === 0;
}

export async function plisioCallback(env: BillingEnv, body: Record<string, unknown>): Promise<Response> {
  if (provider(env) !== "plisio" || !env.PLISIO_API_KEY || !(await verifyPlisioCallback(body, env.PLISIO_API_KEY))) {
    return json({ error: "invalid_callback" }, 422);
  }
  const paymentId = typeof body.order_number === "string" ? body.order_number : "";
  const callbackStatus = typeof body.status === "string" ? body.status : "";
  if (!paymentId || !["completed", "cancelled", "expired", "error"].includes(callbackStatus)) return json({ status: "ignored" });
  if (callbackStatus !== "completed") {
    await env.vpay_db.prepare("UPDATE payments SET status = ?, wallet_address = COALESCE(?, wallet_address), wallet_currency = COALESCE(?, wallet_currency), wallet_amount = COALESCE(?, wallet_amount), updated_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(callbackStatus === "error" ? "failed" : callbackStatus, body.wallet_hash || null, body.psys_cid || body.currency || null, body.amount || null, paymentId).run();
    return json({ status: "ok" });
  }

  const payment = await env.vpay_db.prepare(
    "SELECT user_id, plan_id, credits FROM payments WHERE id = ? AND provider = 'plisio' AND status = 'pending'",
  ).bind(paymentId).first<{ user_id: string; plan_id: number; credits: number }>();
  if (!payment) return json({ status: "ok" });
  await env.vpay_db.prepare("UPDATE payments SET status = 'paid', wallet_address = COALESCE(?, wallet_address), wallet_currency = COALESCE(?, wallet_currency), wallet_amount = COALESCE(?, wallet_amount), paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(body.wallet_hash || null, body.psys_cid || body.currency || null, body.amount || null, paymentId).run();
  const plan = await getPlan(env, payment.plan_id);
  if (plan) {
    await env.vpay_db.prepare(
      `INSERT INTO billing_accounts (user_id, plan_id, plan_name, plan_type, credits_remaining, entitled)
       VALUES (?, ?, ?, 'usage', ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, plan_name = excluded.plan_name,
       plan_type = excluded.plan_type, credits_remaining = billing_accounts.credits_remaining + excluded.credits_remaining,
       entitled = 1, updated_at = datetime('now')`,
    ).bind(payment.user_id, plan.id, plan.name, payment.credits).run();
  }
  return json({ status: "ok" });
}
