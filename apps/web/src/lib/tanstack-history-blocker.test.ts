import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBrowserHistory } from "@tanstack/history";

type FakeEntry = { href: string; state: unknown };
type FakeListener = () => void | Promise<void>;

function fakeBrowserWindow() {
	const entries: FakeEntry[] = [{ href: "/", state: null }];
	const listeners = new Map<string, Set<FakeListener>>();
	const goCalls: number[] = [];
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
			const href = hrefFor(url);
			entries[cursor] = { href, state };
			syncLocation(href);
		},
		go(delta: number) {
			goCalls.push(delta);
			if (!Number.isFinite(delta) || delta === 0) return;
			const next = cursor + delta;
			if (next < 0 || next >= entries.length) return;
			cursor = next;
			syncLocation(entries[cursor]?.href ?? "/");
			emit("popstate");
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
		get href() {
			return entries[cursor]?.href ?? "/";
		},
	};
}

async function settlePop() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
});

afterEach(() => {
	if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
	else Reflect.deleteProperty(globalThis, "document");
});

describe("patched TanStack browser history POP rollback", () => {
	test("rolls blocked Back, Forward, and GO navigation in the opposite direction", async () => {
		const browser = fakeBrowserWindow();
		const history = createBrowserHistory({ window: browser.window });
		history.push("/one");
		history.flush();
		history.push("/two");
		history.flush();
		history.push("/three");
		history.flush();

		let blocked = true;
		history.block({ blockerFn: () => blocked });

		history.back();
		await settlePop();
		expect(browser.href).toBe("/three");
		expect(browser.goCalls.slice(-2)).toEqual([-1, 1]);

		blocked = false;
		history.back();
		await settlePop();
		expect(browser.href).toBe("/two");
		blocked = true;
		history.forward();
		await settlePop();
		expect(browser.href).toBe("/two");
		expect(browser.goCalls.slice(-2)).toEqual([1, -1]);

		history.go(-2);
		await settlePop();
		expect(browser.href).toBe("/two");
		expect(browser.goCalls.slice(-2)).toEqual([-2, 2]);
	});

	test("restores same-index and missing-index POPs without reloading", async () => {
		const browser = fakeBrowserWindow();
		const history = createBrowserHistory({ window: browser.window });
		history.push("/one");
		history.flush();
		history.push("/two");
		history.flush();
		history.block({ blockerFn: () => true });

		browser.window.history.pushState(browser.window.history.state, "", "/two#skills");
		history.back();
		await settlePop();
		expect(browser.href).toBe("/two#skills");
		expect(browser.goCalls).not.toContain(0);

		browser.window.history.pushState({}, "", "/native-entry");
		history.back();
		await settlePop();
		expect(browser.href).toBe("/native-entry");
		expect(browser.goCalls.every(Number.isFinite)).toBe(true);
	});
});
