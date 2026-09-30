import { authenticate, type AuthUser } from "./auth";

type ConfigPayload = {
  targetUrl: string;
  mockResponse: string;
  mockStatus: number;
  watchHosts: string[];
  scripts: Array<{ id: string; name?: string }>;
  captureRules: Array<Record<string, unknown>>;
};

const DEFAULT_CONFIG: ConfigPayload = {
  targetUrl: "https://example.invalid/",
  mockResponse: "",
  mockStatus: 200,
  watchHosts: [],
  scripts: [],
  captureRules: [],
};

const DEFAULT_ENGINE = `window.policy = { decide: () => ({ action: "continue" }) };`;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function encodePayload(payload: unknown, sessionKey: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(payload));
  const key = await sha256Bytes(sessionKey);
  const output = input.map((byte, index) => byte ^ key[index % key.length]);
  return toBase64(output);
}

export async function hmacHex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sessionKeyFor(user: AuthUser, env: Env, request: Request): Promise<string | null> {
  const header = request.headers.get("Authorization") || "";
  const token = header.slice(7).trim();
  const result = await env.vpay_db.prepare(
    `SELECT s.session_key FROM sessions s
     WHERE s.user_id = ? AND s.access_token_hash = ? AND s.revoked_at IS NULL`,
  ).bind(user.id, await sha256Token(token)).first<{ session_key: string }>();
  return result?.session_key || null;
}

async function sha256Token(value: string): Promise<string> {
  const digest = await sha256Bytes(value);
  return toBase64Url(digest);
}

async function loadJsonConfig(env: Env): Promise<ConfigPayload> {
  const row = await env.vpay_db.prepare("SELECT value_json FROM app_config WHERE key = 'config'").first<{ value_json: string }>();
  if (!row) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.value_json) } as ConfigPayload;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function getConfig(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const sessionKey = await sessionKeyFor(user, env, request);
  if (!sessionKey) return Response.json({ error: "invalid_session", message: "Your session has expired." }, { status: 401 });
  const data = await encodePayload(await loadJsonConfig(env), sessionKey);
  return Response.json({ data, signature: await hmacHex(sessionKey, data) });
}

export async function getEngine(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const sessionKey = await sessionKeyFor(user, env, request);
  if (!sessionKey) return Response.json({ error: "invalid_session", message: "Your session has expired." }, { status: 401 });
  return Response.json({ code: DEFAULT_ENGINE, version: "1.0.0", signature: await hmacHex(sessionKey, DEFAULT_ENGINE) });
}

export async function getScript(request: Request, env: Env, user: AuthUser, id: string): Promise<Response> {
  const sessionKey = await sessionKeyFor(user, env, request);
  if (!sessionKey) return Response.json({ error: "invalid_session", message: "Your session has expired." }, { status: 401 });
  const script = await env.vpay_db.prepare("SELECT id, name, code FROM scripts WHERE id = ? AND active = 1").bind(id).first<{ id: string; name: string; code: string }>();
  if (!script) return Response.json({ error: "not_found", message: "Script not found." }, { status: 404 });
  return Response.json(script);
}

export { authenticate };
