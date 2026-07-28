import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
	type BlockerFnArgs,
	createBrowserHistory as createEsmBrowserHistory,
} from "@tanstack/history";

const require = createRequire(import.meta.url);
const { createBrowserHistory: createCjsBrowserHistory }: typeof import("@tanstack/history") =
	require("@tanstack/history");

type FakeEntry = { href: string; state: unknown };
type FakeListener = () => void | Promise<void>;

function deferred<T>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function fakeBrowserWindow() {
	const entries: FakeEntry[] = [{ href: "/", state: null }];
	const listeners = new Map<string, Set<FakeListener>>();
	const goCalls: number[] = [];
	const pendingTraversals: number[] = [];
	let replaceCalls = 0;
	let cursor = 0;
	const location = { pathname: "/", search: "", hash: "" };

	function syncLocation(href: string) {
		const url = new URL(href, "https://clawdi.test");
		location.pathname = url.pathname;
		location.search = url.search;
		location.hash = url.hash;
	}

	function hrefFor(url: string | URL | null | undefined): string {
		if (url === undefined || url === null || url === "") return entries[cursor]?.href ?? "/";
		const parsed = new URL(url.toString(), "https://clawdi.test");
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	}

	function emit(type: string) {
		for (const listener of listeners.get(type) ?? []) void listener();
	}

	const history = {
		get state() {
			return entries[cursor]?.state;
		},
		get length() {
			return entries.length;
		},
		pushState(state: unknown, _title: string, url?: string | URL | null) {
			const href = hrefFor(url);
			entries.splice(cursor + 1, entries.length, { href, state });
			cursor += 1;
			syncLocation(href);
		},
		replaceState(state: unknown, _title: string, url?: string | URL | null) {
			replaceCalls += 1;
			const href = hrefFor(url);
			entries[cursor] = { href, state };
			syncLocation(href);
		},
		go(delta: number) {
			goCalls.push(delta);
			pendingTraversals.push(delta);
		},
		back() {
			this.go(-1);
		},
		forward() {
			this.go(1);
		},
	};

	return {
		window: {
			history,
			location,
			addEventListener(type: string, listener: FakeListener) {
				const current = listeners.get(type) ?? new Set<FakeListener>();
				current.add(listener);
				listeners.set(type, current);
			},
			removeEventListener(type: string, listener: FakeListener) {
				listeners.get(type)?.delete(listener);
			},
		},
		goCalls,
		runNextTraversal() {
			const delta = pendingTraversals.shift();
			if (delta === undefined || !Number.isFinite(delta) || delta === 0) return false;
			const next = cursor + delta;
			if (next < 0 || next >= entries.length) return false;
			cursor = next;
			syncLocation(entries[cursor]?.href ?? "/");
			emit("popstate");
			return true;
		},
		entriesSnapshot() {
			return structuredClone(entries);
		},
		get pendingTraversals() {
			return [...pendingTraversals];
		},
		get replaceCalls() {
			return replaceCalls;
		},
		get cursor() {
			return cursor;
		},
		get href() {
			return entries[cursor]?.href ?? "/";
		},
	};
}

async function settlePop() {
	await Promise.resolve();
	await Promise.resolve();
}

const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
});

afterEach(() => {
	if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
	else Reflect.deleteProperty(globalThis, "document");
});

const implementations = [
	["ESM", createEsmBrowserHistory],
	["CJS", createCjsBrowserHistory],
] as const;

for (const [entrypoint, createBrowserHistory] of implementations) {
	describe(`patched TanStack browser history POP transaction (${entrypoint})`, () => {
		test("rolls indexed Back, Forward, and multi-step GO in the opposite direction", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			for (const href of ["/one", "/two", "/three"]) {
				history.push(href);
				history.flush();
			}

			let blocked = true;
			history.block({ blockerFn: () => blocked });

			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.pendingTraversals).toEqual([1]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.href).toBe("/three");
			expect(browser.goCalls.slice(-2)).toEqual([-1, 1]);

			blocked = false;
			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.href).toBe("/two");
			blocked = true;
			history.forward();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.pendingTraversals).toEqual([-1]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.href).toBe("/two");
			expect(browser.goCalls.slice(-2)).toEqual([1, -1]);

			history.go(-2);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.pendingTraversals).toEqual([2]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.href).toBe("/two");
			expect(browser.goCalls.slice(-2)).toEqual([-2, 2]);
		});

		test("coalesces rapid Back POPs into one resolver and restores the exact origin", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			for (const href of ["/one", "/two", "/three"]) {
				history.push(href);
				history.flush();
			}
			const origin = structuredClone(history.location);
			const entries = browser.entriesSnapshot();
			const replaceCalls = browser.replaceCalls;
			const decision = deferred<boolean>();
			const blockerCalls: BlockerFnArgs[] = [];
			let shouldDefer = true;
			history.block({
				blockerFn: (args) => {
					blockerCalls.push(args);
					return shouldDefer ? decision.promise : false;
				},
			});

			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(blockerCalls).toHaveLength(1);
			expect(blockerCalls[0]?.currentLocation.href).toBe("/three");
			expect(blockerCalls[0]?.nextLocation.href).toBe("/two");
			expect(browser.href).toBe("/one");
			expect(browser.cursor).toBe(1);

			decision.resolve(true);
			await settlePop();
			expect(browser.pendingTraversals).toEqual([2]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.href).toBe(origin.href);
			expect(browser.cursor).toBe(3);
			expect(history.location).toEqual(origin);
			expect(browser.entriesSnapshot()).toEqual(entries);
			expect(browser.replaceCalls).toBe(replaceCalls);
			expect(browser.goCalls.slice(-3)).toEqual([-1, -1, 2]);

			shouldDefer = false;
			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(history.location.href).toBe("/two");
			history.forward();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(history.location).toEqual(origin);
		});

		test("coalesces rapid Forward and mixed GO POPs against their latest observed cursor", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			for (const href of ["/one", "/two", "/three"]) {
				history.push(href);
				history.flush();
			}
			history.go(-2);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(history.location.href).toBe("/one");

			let decision = deferred<boolean>();
			const blockerCalls: BlockerFnArgs[] = [];
			const unblock = history.block({
				blockerFn: (args) => {
					blockerCalls.push(args);
					return decision.promise;
				},
			});
			const forwardOrigin = structuredClone(history.location);
			history.forward();
			expect(browser.runNextTraversal()).toBeTrue();
			history.forward();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(blockerCalls).toHaveLength(1);
			decision.resolve(true);
			await settlePop();
			expect(browser.pendingTraversals).toEqual([-2]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(history.location).toEqual(forwardOrigin);
			expect(browser.goCalls.slice(-3)).toEqual([1, 1, -2]);

			unblock();
			history.go(2);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			const mixedOrigin = structuredClone(history.location);
			decision = deferred<boolean>();
			history.block({
				blockerFn: (args) => {
					blockerCalls.push(args);
					return decision.promise;
				},
			});
			history.go(-2);
			expect(browser.runNextTraversal()).toBeTrue();
			history.forward();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			decision.resolve(true);
			await settlePop();
			expect(browser.pendingTraversals).toEqual([1]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(history.location).toEqual(mixedOrigin);
			expect(browser.goCalls.slice(-3)).toEqual([-2, 1, 1]);
		});

		test("commits the latest rapid POP target after one Proceed decision", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			for (const href of ["/one", "/two", "/three"]) {
				history.push(href);
				history.flush();
			}
			const decision = deferred<boolean>();
			let blockerCalls = 0;
			history.block({
				blockerFn: () => {
					blockerCalls += 1;
					return decision.promise;
				},
			});
			const notifications: Array<{ location: { href: string }; action: { type: string } }> = [];
			history.subscribe(({ location, action }) => notifications.push({ location, action }));

			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			decision.resolve(false);
			await settlePop();

			expect(blockerCalls).toBe(1);
			expect(browser.href).toBe("/one");
			expect(history.location.href).toBe("/one");
			expect(browser.pendingTraversals).toEqual([]);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.location.href).toBe("/one");
			expect(notifications[0]?.action.type).toBe("GO");
		});

		test("finishes without go(0) when rapid POPs return to the origin", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			for (const href of ["/one", "/two"]) {
				history.push(href);
				history.flush();
			}
			const origin = structuredClone(history.location);
			const decision = deferred<boolean>();
			let blockerCalls = 0;
			history.block({
				blockerFn: () => {
					blockerCalls += 1;
					return decision.promise;
				},
			});

			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			history.forward();
			expect(browser.runNextTraversal()).toBeTrue();
			decision.resolve(true);
			await settlePop();

			expect(blockerCalls).toBe(1);
			expect(browser.goCalls.slice(-2)).toEqual([-1, 1]);
			expect(browser.pendingTraversals).toEqual([]);
			expect(history.location).toEqual(origin);
		});

		test("retains upstream go(1) fallback for same-index native entries", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			history.push("/one");
			history.flush();
			history.push("/two");
			history.flush();
			history.block({ blockerFn: () => true });

			browser.window.history.pushState(browser.window.history.state, "", "/two#skills");
			const entries = browser.entriesSnapshot();
			const replaceCalls = browser.replaceCalls;
			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.pendingTraversals).toEqual([1]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();

			expect(browser.href).toBe("/two#skills");
			expect(browser.goCalls.slice(-2)).toEqual([-1, 1]);
			expect(browser.replaceCalls).toBe(replaceCalls);
			expect(browser.entriesSnapshot()).toEqual(entries);
		});

		test("retains upstream go(1) fallback for missing-index native entries", async () => {
			const browser = fakeBrowserWindow();
			const history = createBrowserHistory({ window: browser.window });
			history.push("/one");
			history.flush();
			browser.window.history.pushState({}, "", "/native-entry");
			browser.window.history.pushState(
				{ __TSR_index: 2, __TSR_key: "managed", key: "managed" },
				"",
				"/managed",
			);
			history.block({ blockerFn: () => true });
			const entries = browser.entriesSnapshot();
			const replaceCalls = browser.replaceCalls;

			history.back();
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();
			expect(browser.pendingTraversals).toEqual([1]);
			expect(browser.runNextTraversal()).toBeTrue();
			await settlePop();

			expect(browser.href).toBe("/managed");
			expect(browser.goCalls.slice(-2)).toEqual([-1, 1]);
			expect(browser.replaceCalls).toBe(replaceCalls);
			expect(browser.entriesSnapshot()).toEqual(entries);
			expect(browser.goCalls.every((delta) => Number.isFinite(delta) && delta !== 0)).toBeTrue();
		});
	});
}
