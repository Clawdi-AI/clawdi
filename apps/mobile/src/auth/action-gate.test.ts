import { expect, test } from "bun:test";
import { createActionGate } from "./action-gate";

test("duplicate submissions lock synchronously before a render", () => {
	const gate = createActionGate();
	const first = gate.acquire();
	expect(first).not.toBeNull();
	expect(gate.acquire()).toBeNull();
	first?.release();
	expect(gate.acquire()).not.toBeNull();
});

test("unmount fences an action and prevents new submissions", () => {
	const gate = createActionGate();
	const first = gate.acquire();
	gate.deactivate();
	expect(first?.isCurrent()).toBe(false);
	expect(gate.acquire()).toBeNull();
});

test("StrictMode replay cannot revive old actions or release a new action lock", () => {
	const gate = createActionGate();
	gate.activate();
	const old = gate.acquire();
	gate.deactivate();
	gate.activate();
	const next = gate.acquire();
	expect(old?.isCurrent()).toBe(false);
	expect(next?.isCurrent()).toBe(true);
	old?.release();
	expect(gate.acquire()).toBeNull();
	next?.release();
	expect(gate.acquire()).not.toBeNull();
});

test("account ownership change invalidates stale action completion", () => {
	const gate = createActionGate();
	gate.activate("account-a");
	const old = gate.acquire();
	gate.activate("account-b");
	const next = gate.acquire();
	expect(old?.isCurrent()).toBe(false);
	expect(next?.isCurrent()).toBe(true);
	old?.release();
	expect(gate.acquire()).toBeNull();
});
