import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
	AccountScopeChangedError,
	accountQueryKey,
	clearAccountScope,
	createAccountScope,
	isObsoleteAccountQuery,
	readInAccountScope,
} from "./account-scope";

function deferred<Data>() {
	let resolve: (value: Data) => void = () => {
		throw new Error("Not initialized");
	};
	let reject: (reason: Error) => void = () => {
		throw new Error("Not initialized");
	};
	const promise = new Promise<Data>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function fixture() {
	let current = true;
	const scope = createAccountScope("user:session", "user", "session", 0, () => current);
	return {
		scope,
		switchAccount: () => {
			current = false;
			scope.abort();
		},
	};
}

describe("account read fencing", () => {
	test("StrictMode setup/cleanup/setup permits new reads and fences old ignored-abort success", async () => {
		const { scope } = fixture();
		scope.activate();
		const pending = deferred<string>();
		const oldRead = readInAccountScope(scope, () => pending.promise);
		const oldSignal = scope.signal;
		scope.abort();
		scope.activate();
		expect(oldSignal.aborted).toBe(true);
		expect(scope.signal.aborted).toBe(false);
		pending.resolve("old account data");
		await expect(oldRead).rejects.toBeInstanceOf(AccountScopeChangedError);
		expect(await readInAccountScope(scope, async () => "new lease")).toBe("new lease");
	});

	test("replayed lease fences an old reader error", async () => {
		const { scope } = fixture();
		const pending = deferred<string>();
		const oldRead = readInAccountScope(scope, () => pending.promise);
		scope.abort();
		scope.activate();
		pending.reject(new Error("private old reader failure"));
		await expect(oldRead).rejects.toBeInstanceOf(AccountScopeChangedError);
	});

	for (const outcome of ["success", "error"] as const) {
		test(`account switch fences stale ${outcome}`, async () => {
			const { scope, switchAccount } = fixture();
			const pending = deferred<string>();
			const read = readInAccountScope(scope, () => pending.promise);
			switchAccount();
			if (outcome === "success") pending.resolve("private account data");
			else pending.reject(new Error("private reader error"));
			await expect(read).rejects.toBeInstanceOf(AccountScopeChangedError);
		});
	}

	test("unmount aborts in-flight reads and prevents new reads", async () => {
		const { scope } = fixture();
		const pending = deferred<string>();
		const read = readInAccountScope(scope, () => pending.promise);
		scope.abort();
		pending.resolve("ignored cancellation");
		await expect(read).rejects.toBeInstanceOf(AccountScopeChangedError);
		await expect(readInAccountScope(scope, async () => "never")).rejects.toBeInstanceOf(
			AccountScopeChangedError,
		);
	});

	test("caller cancellation propagates reason even when reader ignores abort", async () => {
		const { scope } = fixture();
		const caller = new AbortController();
		const pending = deferred<string>();
		const reason = new Error("caller cancelled");
		const read = readInAccountScope(
			scope,
			(signal) => {
				expect(signal.aborted).toBe(false);
				return pending.promise;
			},
			caller.signal,
		);
		caller.abort(reason);
		pending.resolve("ignored cancellation");
		await expect(read).rejects.toBe(reason);
		expect(scope.signal.aborted).toBe(false);
	});

	test("already cancelled callers do not start readers", async () => {
		const { scope } = fixture();
		const caller = new AbortController();
		caller.abort();
		let calls = 0;
		await expect(
			readInAccountScope(
				scope,
				async () => {
					calls++;
				},
				caller.signal,
			),
		).rejects.toHaveProperty("name", "AbortError");
		expect(calls).toBe(0);
	});

	test("account transition removes old queries while preserving newly mounted and unrelated queries", () => {
		const client = new QueryClient();
		const oldScope = fixture().scope;
		const next = createAccountScope("other:session", "other", "session", 1, () => true);
		client.setQueryData(accountQueryKey(oldScope, "agents"), "old data");
		client.setQueryData(accountQueryKey(next, "agents"), "new data");
		client.setQueryData(["configuration"], "shared data");
		client.removeQueries({ predicate: ({ queryKey }) => isObsoleteAccountQuery(next, queryKey) });
		expect(client.getQueryData<string>(accountQueryKey(oldScope, "agents"))).toBeUndefined();
		expect(client.getQueryData<string>(accountQueryKey(next, "agents"))).toBe("new data");
		expect(client.getQueryData<string>(["configuration"])).toBe("shared data");
		const laterSession = createAccountScope(
			"later",
			oldScope.accountKey,
			"later",
			oldScope.generation + 1,
			() => true,
		);
		client.setQueryData(accountQueryKey(oldScope, "agents"), "late old data");
		client.setQueryData(accountQueryKey(laterSession, "agents"), "later session data");
		clearAccountScope(oldScope, client);
		expect(oldScope.signal.aborted).toBe(true);
		expect(client.getQueryData<string>(accountQueryKey(oldScope, "agents"))).toBeUndefined();
		expect(client.getQueryData<string>(accountQueryKey(laterSession, "agents"))).toBe(
			"later session data",
		);
		expect(client.getQueryData<string>(accountQueryKey(next, "agents"))).toBe("new data");
		expect(client.getQueryData<string>(["configuration"])).toBe("shared data");
		client.clear();
	});
});
