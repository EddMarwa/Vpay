const PASSWORD_ITERATIONS = 100_000;
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type UserRow = {
  id: string;
  email: string;
  role: string;
  account_disabled: number;
};

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  accountDisabled: boolean;
};

type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
};

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const digest = await derivePassword(password, salt);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(digest)}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsValue, saltValue, digestValue] = encoded.split("$");
  if (algorithm !== "pbkdf2" || Number(iterationsValue) !== PASSWORD_ITERATIONS || !saltValue || !digestValue) return false;
  const digest = await derivePassword(password, fromBase64Url(saltValue));
  return constantTimeEqual(digest, fromBase64Url(digestValue));
}

function publicUser(user: UserRow): AuthUser {
  return { id: user.id, email: user.email, role: user.role, accountDisabled: Boolean(user.account_disabled) };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateCredentials(body: Record<string, unknown>): { email: string; password: string } | Response {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "invalid_email", message: "Enter a valid email address." }, 400);
  if (password.length < 8 || password.length > 256) return json({ error: "invalid_password", message: "Password must be 8 to 256 characters." }, 400);
  return { email, password };
}

async function issueSession(env: Env, user: UserRow): Promise<SessionTokens> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const sessionKey = randomToken();
  const now = Date.now();
  await env.vpay_db.prepare(
    `INSERT INTO sessions
     (id, user_id, refresh_token_hash, access_token_hash, access_expires_at, session_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), user.id, await sha256(refreshToken), await sha256(accessToken),
    new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(), sessionKey, new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
  ).run();
  return { accessToken, refreshToken, sessionKey };
}

export async function register(env: Env, body: Record<string, unknown>): Promise<Response> {
  const credentials = validateCredentials(body);
  if (credentials instanceof Response) return credentials;
  const user: UserRow = { id: crypto.randomUUID(), email: credentials.email, role: "user", account_disabled: 0 };
  try {
    await env.vpay_db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").bind(user.id, user.email, await hashPassword(credentials.password)).run();
    return json({ ...await issueSession(env, user), user: publicUser(user) }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return json({ error: "email_in_use", message: "An account with that email already exists." }, 409);
    throw error;
  }
}

export async function login(env: Env, body: Record<string, unknown>): Promise<Response> {
  const credentials = validateCredentials(body);
  if (credentials instanceof Response) return credentials;
  const result = await env.vpay_db.prepare("SELECT id, email, role, account_disabled, password_hash FROM users WHERE email = ?").bind(credentials.email).first<UserRow & { password_hash: string }>();
  if (!result || !(await verifyPassword(credentials.password, result.password_hash))) return json({ error: "invalid_credentials", message: "Email or password is incorrect." }, 401);
  if (result.account_disabled) return json({ error: "account_disabled", message: "This account has been disabled." }, 403);
  return json({ ...await issueSession(env, result), user: publicUser(result) });
}

export async function refresh(env: Env, body: Record<string, unknown>): Promise<Response> {
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  const session = await env.vpay_db.prepare(
    `SELECT s.id, s.session_key, u.id, u.email, u.role, u.account_disabled
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')`,
  ).bind(await sha256(refreshToken)).first<UserRow & { id: string; session_key: string }>();
  if (!session || session.account_disabled) return json({ error: "invalid_refresh_token", message: "Your session has expired." }, 401);
  const accessToken = randomToken();
  await env.vpay_db.prepare("UPDATE sessions SET access_token_hash = ?, access_expires_at = ?, last_seen_at = datetime('now') WHERE id = ?").bind(await sha256(accessToken), new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(), session.id).run();
  return json({ accessToken, refreshToken, sessionKey: session.session_key, user: publicUser(session) });
}

export async function logout(env: Env, body: Record<string, unknown>): Promise<Response> {
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  if (refreshToken) await env.vpay_db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE refresh_token_hash = ?").bind(await sha256(refreshToken)).run();
  return json({ ok: true });
}

export async function authenticate(request: Request, env: Env): Promise<AuthUser | null> {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const result = await env.vpay_db.prepare(
    `SELECT u.id, u.email, u.role, u.account_disabled
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.access_token_hash = ? AND s.revoked_at IS NULL AND s.access_expires_at > datetime('now')`,
  ).bind(await sha256(token)).first<UserRow>();
  return result ? publicUser(result) : null;
}

export function parseJson(request: Request): Promise<Record<string, unknown>> {
  return request.json().then((body: unknown) => body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {});
}
