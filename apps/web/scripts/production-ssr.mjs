import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, mock, test } from "node:test";
import { AGENT_FILES } from "../src/lib/agent-files.ts";

// Exercise the deployed bundle graph with real Clerk middleware and providers.
// These syntactically valid fixture keys do not belong to a Clerk tenant.
for (const key of Object.keys(process.env)) {
	if (/^(VITE_|CLERK_|SENTRY_|VERCEL(?:_|$)|CLAWDI_APPLE_|CLAWDI_ANDROID_CERT_)/.test(key)) {
		delete process.env[key];
	}
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

function authenticatedRequest(path) {
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
	return authenticated;
}

for (const [path, envKey, value] of [
	["/.well-known/apple-app-site-association", "CLAWDI_APPLE_TEAM_ID", "ABCDE12345"],
	["/.well-known/assetlinks.json", "CLAWDI_ANDROID_CERT_SHA256", Array(32).fill("AB").join(":")],
]) {
	for (const method of ["GET", "HEAD"]) {
		for (const configured of [false, true]) {
			test(`production ${method} ${path} bypasses auth (${configured ? "configured" : "unset"})`, async () => {
				try {
					if (configured) process.env[envKey] = value;
					else delete process.env[envKey];
					const input = new Request(request(path), { method });
					// A stale credential must not start Clerk's authentication/handshake flow.
					input.headers.set("authorization", "Bearer expired-session");
					input.headers.set("cookie", "__session=expired-session");
					const response = await server.fetch(input);
					assert.equal(response.status, configured ? 200 : 404);
					assert.equal(response.headers.get("location"), null);
					assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
					assert.equal(response.headers.get("content-security-policy"), null);
					assert.equal(response.headers.get("set-cookie"), null);
					assert.equal(response.headers.get("x-clerk-auth-status"), null);
					assert.equal(
						response.headers.get("cache-control"),
						configured ? "public, max-age=300" : "no-store",
					);
					if (configured && method === "GET") {
						assert.match(await response.text(), /ai\.clawdi\.app/);
					} else assert.equal(await response.text(), "");
				} finally {
					delete process.env[envKey];
				}
			});
		}
	}
}

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
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
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

for (const file of Object.values(AGENT_FILES)) {
	for (const method of ["GET", "HEAD"]) {
		test(`production ${method} ${file.path} stays publicly cacheable without a document nonce`, async () => {
			const response = await server.fetch(new Request(request(file.path), { method }));
			assert.equal(response.status, file.path === AGENT_FILES.legacyGuide.path ? 301 : 200);
			assert.equal(
				response.headers.get("cache-control"),
				"public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
			);
			assert.equal(response.headers.get("content-security-policy"), null);
			assert.equal(response.headers.get("content-type"), `${file.contentType}; charset=utf-8`);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
			if (file.path === AGENT_FILES.legacyGuide.path) {
				assert.equal(response.headers.get("location"), "https://clawdi.ai/get-started.md");
			}
		});
	}
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
	test(`production SSR renders signed-in ${path} without a session loading replacement`, async (t) => {
		// Disabled dashboard queries still schedule cache GC; keep those timers
		// scoped to this SSR request instead of retaining them in the test worker.
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const response = await server.fetch(authenticatedRequest(path));
		const html = await response.text();
		assert.equal(response.status, 200, html);
		assert.match(html, /data-testid="dashboard-page-content"/);
		assert.doesNotMatch(html, /Loading session/);
	});
}

test("production SSR redirects the signed-out hosted homepage to the marketing root", async () => {
	const response = await server.fetch(request("/"));
	assert.equal(response.status, 307);
	assert.equal(response.headers.get("location"), "https://clawdi.ai/");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(await response.text(), "");
});

for (const path of [
	"/dashboard",
	"/dashboard?deploy_profile=sui&settings=billing-wallet",
	"/agents",
	"/?settings=billing-wallet",
	"/cli-authorize?user_code=ABCD",
	"/oauth/codex/callback?code=opaque&state=state",
]) {
	test(`production SSR protects ${path} without auth bypass`, async () => {
		const response = await server.fetch(request(path));
		assert.equal(response.status, 307);
		assert.equal(
			response.headers.get("location"),
			`/sign-in?redirect_url=${encodeURIComponent(path)}`,
		);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(await response.text(), "");
	});
}

test("public discovery bypasses Clerk while consecutive dashboard requests retain authentication", async () => {
	for (const path of [
		"/.well-known/agent-skills/index.json",
		"/dashboard",
		"/.well-known/agent-skills/index.json",
		"/dashboard",
	]) {
		const response = await server.fetch(authenticatedRequest(path));
		if (path === "/dashboard") {
			// Only Clerk's authenticated context can admit the protected alias.
			assert.equal(response.status, 307);
			assert.equal(response.headers.get("location"), "/");
			assert.equal(await response.text(), "");
		} else {
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
			assert.equal(response.headers.get("location"), null);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.equal(response.headers.get("x-clerk-auth-status"), null);
			assert.ok((await response.json()).skills.length > 0);
		}
	}
});

for (const search of ["", "?deploy_profile=sui&settings=billing-wallet"]) {
	test(`production SSR admits dashboard alias ${search} before redirecting to overview`, async () => {
		const response = await server.fetch(authenticatedRequest(`/dashboard${search}`));
		assert.equal(response.status, 307);
		assert.equal(response.headers.get("location"), `/${search}`);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(await response.text(), "");
	});
}
