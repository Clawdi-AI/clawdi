import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	cancelOAuthSessionLifecycle,
	isCurrentOAuthGeneration,
	type OAuthSession,
	runOAuthSessionTransition,
} from "./use-provider-oauth-device-flow";

function deferred<T>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function oauthSession(state: string): OAuthSession {
	return {
		mode: "accept",
		providerId: "openai-codex",
		state,
		verificationUrl: "https://auth.openai.com/codex/device",
		userCode: "ABCD-EFGH",
		expiresAt: "2099-01-01T00:00:00Z",
		pollIntervalSeconds: 5,
	};
}

describe("provider OAuth device flow lifecycle", () => {
	test("ignores a ready response from a cancelled or replaced poll generation", () => {
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: true,
				generation: 1,
				currentGeneration: 1,
			}),
		).toBe(false);
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: false,
				generation: 1,
				currentGeneration: 2,
			}),
		).toBe(false);
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: false,
				generation: 2,
				currentGeneration: 2,
			}),
		).toBe(true);
	});

	test("ignores an expiry callback from the replaced session generation", () => {
		expect(
			isCurrentOAuthGeneration({
				stopped: false,
				completed: false,
				generation: 4,
				currentGeneration: 5,
			}),
		).toBe(false);
	});

	test("does not start a session when the flow is cancelled during its pending factory", async () => {
		const lifecycle = { generation: 0, completed: true };
		const pending = deferred<OAuthSession | null>();
		const started: OAuthSession[] = [];
		const transition = runOAuthSessionTransition({
			lifecycle,
			factory: () => pending.promise,
			onStart: (session) => started.push(session),
		});

		cancelOAuthSessionLifecycle(lifecycle);
		pending.resolve(oauthSession("cancelled"));

		expect(await transition).toBe(false);
		expect(started).toEqual([]);
		expect(lifecycle.completed).toBe(true);
	});

	test("only starts the replacement when an older factory resolves late", async () => {
		const lifecycle = { generation: 0, completed: true };
		const first = deferred<OAuthSession | null>();
		const replacement = deferred<OAuthSession | null>();
		const started: OAuthSession[] = [];
		const firstTransition = runOAuthSessionTransition({
			lifecycle,
			factory: () => first.promise,
			onStart: (session) => started.push(session),
		});
		const replacementTransition = runOAuthSessionTransition({
			lifecycle,
			factory: () => replacement.promise,
			onStart: (session) => started.push(session),
		});

		replacement.resolve(oauthSession("replacement"));
		expect(await replacementTransition).toBe(true);
		first.resolve(oauthSession("stale"));
		expect(await firstTransition).toBe(false);
		expect(started.map((session) => session.state)).toEqual(["replacement"]);
	});

	test("allows an explicit new code while the current session is polling", () => {
		const source = readFileSync(new URL("./provider-oauth-flow.tsx", import.meta.url), "utf8");
		expect(source).toContain("onClick={onRestart} disabled={starting}");
		expect(source).not.toContain("disabled={starting || polling}");
	});
});
