import { describe, expect, it } from "bun:test";
import { ApiError } from "../lib/api-client";
import { isAuthFailure } from "./sync-engine";

describe("isAuthFailure", () => {
	// Pull-side and push-side both rely on this classifier to decide
	// whether to abort the daemon vs. log-and-retry. A wrong answer in
	// either direction is bad: missing a 401 means a revoked key
	// silently loops forever (the bug Codex flagged), and false-
	// positives on a transient 5xx would kill a healthy daemon.
	it.each([401, 403])("treats ApiError(%i) as auth failure", (status) => {
		const e = new ApiError({ status, body: "", hint: "" });
		expect(isAuthFailure(e)).toBe(true);
	});

	it.each([
		400, 404, 408, 429, 500, 502, 503,
	])("does not treat ApiError(%i) as auth failure", (status) => {
		const e = new ApiError({ status, body: "", hint: "" });
		expect(isAuthFailure(e)).toBe(false);
	});

	it("does not treat plain Error as auth failure", () => {
		expect(isAuthFailure(new Error("boom"))).toBe(false);
	});

	it("does not treat network errors (ApiError 0) as auth failure", () => {
		// Network errors normalise to status=0 in the api-client. They
		// must keep retrying — only an explicit 401/403 from the
		// server says the key is rejected.
		const e = new ApiError({ status: 0, body: "", hint: "", isNetwork: true });
		expect(isAuthFailure(e)).toBe(false);
	});

	it("does not treat null/undefined/strings as auth failure", () => {
		expect(isAuthFailure(null)).toBe(false);
		expect(isAuthFailure(undefined)).toBe(false);
		expect(isAuthFailure("401")).toBe(false);
		expect(isAuthFailure({ status: 401 })).toBe(false);
	});
});

describe("addInFlight / releaseInFlight refcount", () => {
	// Round-r5 P1: the watcher guard at sync-engine.ts:521 reads
	// `pullsInFlight.has(skillKey)` to short-circuit watcher
	// events fired while writeSkillArchive is rm+extracting (a
	// few-ms window where the dir is empty). Same Map is bumped
	// at the start of `writeSkillArchive` and released in a
	// `finally` — multiple concurrent pulls of the same skill
	// would otherwise have the second `releaseInFlight` clear
	// the entry while the first pull is still extracting,
	// re-opening the watcher echo window. Lock the contract.
	const { addInFlight, releaseInFlight } = require("./sync-engine") as {
		addInFlight: (m: Map<string, number>, k: string) => void;
		releaseInFlight: (m: Map<string, number>, k: string) => void;
	};

	it("has(key) is true between addInFlight and matching releaseInFlight", () => {
		const m = new Map<string, number>();
		addInFlight(m, "foo");
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		expect(m.has("foo")).toBe(false);
	});

	it("nested addInFlight: has() stays true until the LAST release", () => {
		const m = new Map<string, number>();
		addInFlight(m, "foo");
		addInFlight(m, "foo");
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		// First release: still in flight (count = 1).
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		expect(m.has("foo")).toBe(false);
	});

	it("releaseInFlight on missing key is a no-op (does not insert -1 entry)", () => {
		// Defense against an accidental `releaseInFlight` outside
		// a `finally` paired with addInFlight — must not leave a
		// negative-count entry that blocks future watcher events.
		const m = new Map<string, number>();
		releaseInFlight(m, "ghost");
		expect(m.has("ghost")).toBe(false);
	});

	it("entries are independent across keys", () => {
		const m = new Map<string, number>();
		addInFlight(m, "a");
		addInFlight(m, "b");
		expect(m.has("a")).toBe(true);
		expect(m.has("b")).toBe(true);
		releaseInFlight(m, "a");
		expect(m.has("a")).toBe(false);
		expect(m.has("b")).toBe(true);
	});
});
