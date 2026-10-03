import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
	CHANNEL_ATTRIBUTION_SECRET: "ssr-channel-signing-key-32-bytes!!",
	VITE_CLERK_PUBLISHABLE_KEY: "pk_test_c3NyLmNsZXJrLmFjY291bnRzLmRldiQ=",
});

execFileSync("bun", ["run", "build"], {
	cwd: new URL("../", import.meta.url),
	stdio: "pipe",
	timeout: 120_000,
	maxBuffer: 10 * 1024 * 1024,
});

process.env.CLERK_SECRET_KEY = "sk_test_ssr_fixture";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.CLERK_JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
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

test("production channel entry exchanges an invitation before auth or app rendering", async () => {
	const issued = Math.floor(Date.now() / 1000);
	const expires = issued + 900;
	const nonce = "n".repeat(22);
	const signature = createHmac("sha256", process.env.CHANNEL_ATTRIBUTION_SECRET)
		.update(`clawdi/channel-trial/v1|sui|${issued}|${expires}|${nonce}`)
		.digest("base64url");
	const token = `v1.sui.${issued}.${expires}.${nonce}.${signature}`;
	const response = await server.fetch(request(`/attribution/sui?token=${token}`));
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/deploy");
	assert.match(
		response.headers.get("set-cookie") ?? "",
		/__Host-clawdi-channel-attribution=.*;.*HttpOnly; Secure; SameSite=Lax/,
	);
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	assert.equal(await response.text(), "");
	const invalid = await server.fetch(request("/attribution/sui?token=invalid"));
	assert.equal(invalid.status, 400);
	assert.equal(invalid.headers.get("set-cookie"), null);
	const mismatched = await server.fetch(request(`/attribution/other?token=${token}`));
	assert.equal(mismatched.status, 400);
	// The signature implementation and server-only key stay out of public assets.
	const root = new URL("../.vercel/output/static/", import.meta.url);
	for (const file of readdirSync(root, { recursive: true })) {
		if (!file.endsWith(".js")) continue;
		const content = readFileSync(new URL(file, root), "utf8");
		assert.ok(!content.includes(process.env.CHANNEL_ATTRIBUTION_SECRET), `Signing key in ${file}`);
		assert.ok(!content.includes("clawdi/channel-trial/v1"), `Verifier in ${file}`);
	}
});

test("production documents use fresh CSP nonces on every executable script", async () => {
	const nonces = new Set();
	for (let i = 0; i < 2; i++) {
		const response = await server.fetch(request("/sign-in"));
		assert.equal(response.status, 200);
		const csp = response.headers.get("content-security-policy") ?? "";
		const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
		assert.ok(nonce);
		assert.match(csp, /'strict-dynamic'/);
		assert.doesNotMatch(csp, /script-src[^;]*(?:'unsafe-inline'|'unsafe-eval')/);
		assert.match(response.headers.get("cache-control") ?? "", /no-store/);
		nonces.add(nonce);
		const html = await response.text();
		for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
			if (/type="(?:application\/json|application\/ld\+json)"/.test(tag)) continue;
			assert.ok(tag.includes(`nonce="${nonce}"`), `Script without matching nonce: ${tag}`);
		}
		assert.ok(html.includes(`<meta name="csp-nonce" content="${nonce}"`));
	}
	assert.equal(nonces.size, 2);
});

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
	test(`production SSR renders signed-in ${path} without a session loading replacement`, async (t) => {
		// Disabled dashboard queries still schedule cache GC; keep those timers
		// scoped to this SSR request instead of retaining them in the test worker.
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const now = Math.floor(Date.now() / 1000);
		const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const payload = `${encode({ alg: "RS256", typ: "JWT", kid: "ssr-fixture" })}.${encode({
			iss: "https://ssr.clerk.accounts.dev",
			sub: "user_ssr_fixture",
			sid: "sess_ssr_fixture",
			iat: now,
			nbf: now - 5,
			exp: now + 60,
			v: 2,
			sts: "active",
		})}`;
		const token = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
		const authenticated = request(path);
		authenticated.headers.set("authorization", `Bearer ${token}`);
		const response = await server.fetch(authenticated);
		const html = await response.text();
		assert.equal(response.status, 200, html);
		assert.match(html, /data-testid="dashboard-page-content"/);
		assert.doesNotMatch(html, /Loading session/);
	});

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
