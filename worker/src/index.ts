import { login, logout, parseJson, refresh, register } from "./auth";

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
			return withCors(Response.json({ error: "not_found", message: "Route not found." }, { status: 404 }));
		} catch (error) {
			return internalError(error);
		}
	},
} satisfies ExportedHandler<Env>;
