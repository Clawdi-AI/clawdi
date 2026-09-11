import { describe, expect, mock, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import { createRuntimeUiCredentialSession } from "./runtime-ui-credential-session";

function credentials(
	expiry: number | null = Date.now() + 60_000,
): Extract<RuntimeUiCredentials, { runtime: "openclaw" }> {
	return {
		runtime: "openclaw",
		auth_mode: "openclaw_token",
		url: "https://runtime.example/",
		deployment_resource_version: "rv-1",
		token: "shared-token",
		handoff_url: "https://runtime.example/#bootstrapToken=one-time-token&bootstrapProfile=owner",
		browser_bootstrap_expires_at_ms: expiry,
	};
}

function fixture(request: () => Promise<RuntimeUiCredentials>) {
	let loaded = false;
	const session = createRuntimeUiCredentialSession({
		request,
		hasNativeHandoffLoaded: () => loaded,
		markNativeHandoffLoaded: () => {
			loaded = true;
		},
		forgetNativeHandoffLoaded: () => {
			loaded = false;
		},
	});
	return session;
}

describe("agent-owned runtime UI credential session", () => {
	test("prefetch and concurrent open share one request and reuse unexpired credentials", async () => {
		const gate = Promise.withResolvers<RuntimeUiCredentials>();
		const request = mock(() => gate.promise);
		const session = fixture(request);
		let reentrant: Promise<RuntimeUiCredentials | null> | undefined;
		const unsubscribe = session.subscribe(() => {
			if (session.getSnapshot().status === "loading") reentrant = session.load();
		});
		const prefetch = session.preload();
		expect(reentrant).toBe(prefetch);
		unsubscribe();
		expect(session.open()).toBe(prefetch);
		gate.resolve(credentials());
		await prefetch;
		session.leave();
		expect(session.getSnapshot().consoleActive).toBe(false);
		await session.open();
		expect(session.getSnapshot().consoleActive).toBe(true);
		expect(request).toHaveBeenCalledTimes(1);
		expect(session.getSnapshot().nativeHandoffLoaded).toBe(false);
		session.dispose();
	});

	test("expired and unknown-expiry native handoffs are refreshed only on next use", async () => {
		const first = credentials();
		const request = mock(async () => first);
		const session = fixture(request);
		await session.load();
		first.browser_bootstrap_expires_at_ms = Date.now() - 1;
		expect(request).toHaveBeenCalledTimes(1);
		request.mockImplementation(async () => credentials(null));
		await session.load();
		expect(request).toHaveBeenCalledTimes(2);
		await session.load();
		expect(request).toHaveBeenCalledTimes(3);
		session.dispose();
	});

	test("unknown-expiry responses are shared within one console entry, never the next entry", async () => {
		const request = mock(async () => credentials(null));
		const session = fixture(request);
		await session.open();
		await session.open();
		expect(request).toHaveBeenCalledTimes(1);
		session.leave();
		await session.preload();
		expect(request).toHaveBeenCalledTimes(1);
		await session.open();
		expect(request).toHaveBeenCalledTimes(2);
		session.dispose();
	});

	test("consuming a native handoff discards the token and reconnect refreshes exactly once", async () => {
		const request = mock(async () => credentials());
		const session = fixture(request);
		await session.load();
		session.markLoaded(session.getSnapshot().attempt);
		expect(session.getSnapshot().credentials).toBeNull();
		await session.load();
		expect(request).toHaveBeenCalledTimes(1);
		expect(session.getSnapshot().nativeHandoffLoaded).toBe(true);
		const reconnect = session.reconnect();
		expect(session.reconnect()).toBe(reconnect);
		await reconnect;
		expect(request).toHaveBeenCalledTimes(2);
		expect(session.getSnapshot().nativeHandoffLoaded).toBe(false);
		session.dispose();
	});

	test("failed prefetch can retry; reset and identity retirement reject stale responses", async () => {
		const request = mock(async (): Promise<RuntimeUiCredentials> => {
			throw new Error("Unavailable");
		});
		const session = fixture(request);
		await session.load();
		expect(session.getSnapshot().status).toBe("error");
		const stale = Promise.withResolvers<RuntimeUiCredentials>();
		request.mockImplementation(() => stale.promise);
		const retry = session.load();
		await Promise.resolve();
		session.clear();
		request.mockImplementation(async () => credentials());
		await session.load();
		const current = session.getSnapshot();
		stale.resolve(credentials());
		expect(await retry).toBeNull();
		expect(session.getSnapshot()).toBe(current);
		session.clear();
		const retired = Promise.withResolvers<RuntimeUiCredentials>();
		request.mockImplementation(() => retired.promise);
		const oldIdentity = session.load();
		await Promise.resolve();
		session.dispose();
		expect(session.getSnapshot().consoleActive).toBe(false);
		// StrictMode can reactivate the owner before its retired request resolves.
		session.activate();
		const replacement = credentials();
		request.mockImplementation(async () => replacement);
		const newEntry = session.open();
		retired.resolve(credentials());
		expect(await oldIdentity).toBeNull();
		await newEntry;
		expect(session.getSnapshot().credentials).toBe(replacement);
		session.dispose();
		expect(session.getSnapshot().credentials).toBeNull();
	});

	test("shared-token handoffs retain legacy reuse without expiry", async () => {
		const legacy = {
			...credentials(null),
			handoff_url: "https://runtime.example/#token=shared-token",
		};
		const request = mock(async () => legacy);
		const session = fixture(request);
		await session.load();
		await session.load();
		session.markLoaded(session.getSnapshot().attempt);
		expect(session.getSnapshot().credentials).toBe(legacy);
		expect(request).toHaveBeenCalledTimes(1);
		session.dispose();
	});
});
