import type { AuthUser } from "./auth";

type BillingRow = {
  plan_name: string | null;
  plan_type: string | null;
  credits_remaining: number;
  used: number;
  expires_at: string | null;
  entitled: number;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function billing(env: Env, userId: string): Promise<BillingRow | null> {
  return env.vpay_db.prepare(
    `SELECT plan_name, plan_type, credits_remaining, used, expires_at, entitled
     FROM billing_accounts WHERE user_id = ?`,
  ).bind(userId).first<BillingRow>();
}

export function billingEntitled(entitled: number | boolean | null | undefined, expiresAt: string | null | undefined): boolean {
  if (!entitled) return false;
  if (!expiresAt) return true;

  const normalized = expiresAt.includes("T") ? expiresAt : expiresAt.replace(" ", "T");
  const expiresAtMs = Date.parse(normalized);
  if (!Number.isFinite(expiresAtMs)) return true;

  return expiresAtMs > Date.now();
}

function billingPayload(row: BillingRow | null) {
  if (!row) return null;
  return {
    planName: row.plan_name,
    planType: row.plan_type,
    creditsRemaining: row.credits_remaining,
    used: row.used,
    expiresAt: row.expires_at,
    entitled: billingEntitled(row.entitled, row.expires_at),
  };
}

export async function reportInterception(env: Env, user: AuthUser, body: Record<string, unknown>): Promise<Response> {
  const method = typeof body.method === "string" ? body.method.trim().slice(0, 20) : "GET";
  const url = typeof body.url === "string" ? body.url.slice(0, 4096) : "";
  const status = Number(body.status);
  if (!url || !method || !Number.isInteger(status) || status < 100 || status > 599) {
    return json({ error: "invalid_interception", message: "Invalid interception data." }, 400);
  }

  const update = await env.vpay_db.prepare(
    `UPDATE billing_accounts
     SET used = used + 1,
         credits_remaining = CASE WHEN plan_type = 'usage' THEN credits_remaining - 1 ELSE credits_remaining END,
         entitled = CASE WHEN plan_type = 'usage' AND credits_remaining <= 1 THEN 0 ELSE entitled END,
         updated_at = datetime('now')
     WHERE user_id = ? AND entitled = 1
       AND (plan_type = 'time' OR credits_remaining > 0)
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
  ).bind(user.id).run();
  if (update.meta.changes !== 1) {
    return json({ error: "plan_required", message: "An active credit plan is required.", billing: billingPayload(await billing(env, user.id)) }, 403);
  }

  await env.vpay_db.prepare(
    "INSERT INTO interceptions (user_id, method, url, status) VALUES (?, ?, ?, ?)",
  ).bind(user.id, method, url, status).run();
  return json({ billing: billingPayload(await billing(env, user.id)) });
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function serializedJson(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return null;
  }
}

export async function createRecord(env: Env, user: AuthUser, body: Record<string, unknown>): Promise<Response> {
  const method = boundedText(body.method, 20) || "GET";
  const url = boundedText(body.url, 4096);
  if (!url) return json({ error: "invalid_record", message: "A record URL is required." }, 400);
  const status = body.status === null || body.status === undefined ? null : Number(body.status);
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
    return json({ error: "invalid_record", message: "Invalid record status." }, 400);
  }
  await env.vpay_db.prepare(
    `INSERT INTO records
     (user_id, rule_id, rule_name, method, url, status, request_headers_json, request_body,
      response_headers_json, response_body, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    user.id,
    boundedText(body.ruleId, 128),
    boundedText(body.ruleName, 256),
    method,
    url,
    status,
    serializedJson(body.requestHeaders, 65536),
    boundedText(body.requestBody, 65536),
    serializedJson(body.responseHeaders, 65536),
    boundedText(body.responseBody, 65536),
    boundedText(body.capturedAt, 64),
  ).run();
  return json({ ok: true });
}
