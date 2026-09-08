import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, mock, test } from "node:test";

// Exercise the deployed bundle graph with real Clerk middleware and providers.
// These syntactically valid fixture keys do not belong to a Clerk tenant.
for (const key of Object.keys(process.env)) {
	if (/^(VITE_|CLERK_|SENTRY_|VERCEL(?:_|$))/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
	NODE_ENV: "production",
	CI: "1",
	VERCEL: "1",
	VERCEL_ENV: "production",
	NITRO_PRESET: "vercel",
	VITE_CLAWDI_HOSTED: "true",
	VITE_DEV_AUTH_BYPASS: "false",
	VITE_CLERK_PUBLISHABLE_KEY: "pk_test_c3NyLmNsZXJrLmFjY291bnRzLmRldiQ=",
});

execFileSync("bun", ["run", "build"], {
	cwd: new URL("../", import.meta.url),
	stdio: "pipe",
	timeout: 120_000,
	maxBuffer: 10 * 1024 * 1024,
});

process.env.CLERK_SECRET_KEY = "sk_test_ssr_fixture";
process.env.CLERK_TELEMETRY_DISABLED = "1";
const network = mock.method(globalThis, "fetch", () => {
	throw new Error("Public signed-out SSR must not need an external service");
});
const { default: server } = await import("../.vercel/output/functions/__server.func/index.mjs");

after(() => {
	assert.equal(network.mock.calls.length, 0, "SSR attempted an external request");
});

function request(path) {
	return new Request(`http://localhost:3100${path}`, {
		headers: { "user-agent": "Mozilla/5.0" },
	});
}

for (const [path, title] of [
	["/sign-in", "Sign in"],
	["/sign-in/factor-one", "Sign in"],
	["/sign-up", "Sign up"],
	["/sign-up/verify-email-address", "Sign up"],
]) {
	test(`production SSR renders ${path} with Clerk`, async () => {
		const response = await server.fetch(request(path));
		const html = await response.text();
		assert.equal(response.status, 200, html);
		assert.match(response.headers.get("content-type"), /text\/html/);
		assert.ok(html.includes(`<title>${title} · Clawdi</title>`));
		assert.match(html, /window\.__clerk_init_state = /);
		assert.match(html, /"isAuthenticated":false/);
		assert.match(html, /<\/body><\/html>$/);
	});
}

for (const path of ["/", "/agents"]) {
	test(`production SSR protects ${path} without auth bypass`, async () => {
		const response = await server.fetch(request(path));
		assert.equal(response.status, 307);
		assert.equal(
			response.headers.get("location"),
			`/sign-in?redirect_url=${encodeURIComponent(path)}`,
		);
		assert.equal(await response.text(), "");
	});
}
