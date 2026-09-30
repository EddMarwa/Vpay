import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import initialSchema from "../migrations/0001_initial.sql?raw";
import accessTokenSchema from "../migrations/0002_session_access_tokens.sql?raw";

beforeAll(async () => {
	const statements = `${initialSchema.replace("PRAGMA foreign_keys = ON;", "")}\n${accessTokenSchema}`
		.split(/;\s*(?:\r?\n|$)/)
		.map((statement) => statement.trim())
		.filter(Boolean);
	for (const statement of statements) await env.vpay_db.prepare(statement).run();
});
