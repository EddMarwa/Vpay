import { authenticate, login, logout, parseJson, refresh, register } from "./auth";
import { cancel, checkout, plisioCallback, purchase, status } from "./billing";
import { getConfig, getEngine, getScript } from "./policy";
import { createRecord, reportInterception } from "./usage";

const CORS_HEADERS = {
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Origin": "*",
};

function withCors(body: Response): Response {
	const headers = new Headers(body.headers);
	for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
	return new Response(body.body, { status: body.status, headers });
}

function internalError(error: unknown): Response {
	console.error("Unhandled request error", error);
	return Response.json(
		{ error: "internal_error", message: "The server encountered an unexpected error." },
		{ status: 500, headers: CORS_HEADERS },
	);
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
			const url = new URL(request.url);
			if (url.pathname === "/api/auth/register" && request.method === "POST") return withCors(await register(env, await parseJson(request)));
			if (url.pathname === "/api/auth/login" && request.method === "POST") return withCors(await login(env, await parseJson(request)));
			if (url.pathname === "/api/auth/refresh" && request.method === "POST") return withCors(await refresh(env, await parseJson(request)));
			if (url.pathname === "/api/auth/logout" && request.method === "POST") return withCors(await logout(env, await parseJson(request)));
			if (url.pathname === "/api/billing/plisio/callback" && request.method === "POST") return withCors(await plisioCallback(env, await parseJson(request)));
			const scriptMatch = url.pathname.match(/^\/api\/scripts\/([^/]+)$/);
			const paymentCancelMatch = url.pathname.match(/^\/api\/billing\/payments\/([^/]+)\/cancel$/);
			const protectedRoute = (request.method === "GET" && (url.pathname === "/api/config" || url.pathname === "/api/engine" || Boolean(scriptMatch)))
				|| (request.method === "GET" && url.pathname === "/api/billing/status")
				|| (request.method === "POST" && (url.pathname === "/api/interceptions" || url.pathname === "/api/records" || url.pathname === "/api/billing/checkout" || url.pathname === "/api/billing/purchase" || Boolean(paymentCancelMatch)));
			if (!protectedRoute) return withCors(Response.json({ error: "not_found", message: "Route not found." }, { status: 404 }));
			const user = await authenticate(request, env);
			if (!user) return withCors(Response.json({ error: "unauthorized", message: "Sign in required." }, { status: 401 }));
			if (url.pathname === "/api/config") return withCors(await getConfig(request, env, user));
			if (url.pathname === "/api/engine") return withCors(await getEngine(request, env, user));
			if (scriptMatch) return withCors(await getScript(request, env, user, decodeURIComponent(scriptMatch[1])));
			if (url.pathname === "/api/interceptions") return withCors(await reportInterception(env, user, await parseJson(request)));
			if (url.pathname === "/api/records") return withCors(await createRecord(env, user, await parseJson(request)));
			if (url.pathname === "/api/billing/status") return withCors(await status(request, env, user));
			if (url.pathname === "/api/billing/checkout") return withCors(await checkout(env, user, await parseJson(request)));
			if (url.pathname === "/api/billing/purchase") return withCors(await purchase(env, user, await parseJson(request)));
			if (paymentCancelMatch) return withCors(await cancel(env, user, decodeURIComponent(paymentCancelMatch[1])));
			return withCors(Response.json({ error: "not_found", message: "Route not found." }, { status: 404 }));
		} catch (error) {
			return internalError(error);
		}
	},
} satisfies ExportedHandler<Env>;
