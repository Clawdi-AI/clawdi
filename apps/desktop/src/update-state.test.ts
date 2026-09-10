import { describe, expect, test } from "bun:test";
import {
	canCheckForDesktopUpdate,
	desktopUpdateStatusLabel,
	reduceDesktopUpdateState,
} from "./update-state";

describe("desktop update state", () => {
	test("tracks check, download progress, and readiness", () => {
		let state = reduceDesktopUpdateState({ status: "idle" }, { type: "check" });
		expect(state).toEqual({ status: "checking" });
		state = reduceDesktopUpdateState(state, { type: "available", version: "1.4.0" });
		state = reduceDesktopUpdateState(state, { type: "progress", percent: 42.4 });
		expect(desktopUpdateStatusLabel(state)).toBe("Downloading Clawdi 1.4.0… 42%");
		state = reduceDesktopUpdateState(state, { type: "downloaded", version: "1.4.0" });
		expect(state).toEqual({ status: "ready", version: "1.4.0" });
	});

	test("keeps disabled builds inert", () => {
		const disabled = { status: "disabled", reason: "unsigned" } as const;
		expect(reduceDesktopUpdateState(disabled, { type: "check" })).toBe(disabled);
		expect(reduceDesktopUpdateState(disabled, { type: "downloaded", version: "9.9.9" })).toBe(
			disabled,
		);
	});

	test("recovers to idle after no update and records failures without raw errors", () => {
		expect(reduceDesktopUpdateState({ status: "checking" }, { type: "not-available" })).toEqual({
			status: "idle",
		});
		expect(reduceDesktopUpdateState({ status: "checking" }, { type: "error" })).toEqual({
			status: "error",
		});
	});

	test("does not replace an active download or ready update with a duplicate check", () => {
		const downloading = { status: "downloading", version: "1.4.0", percent: 25 } as const;
		const ready = { status: "ready", version: "1.4.0" } as const;
		expect(canCheckForDesktopUpdate({ status: "idle" })).toBe(true);
		expect(canCheckForDesktopUpdate({ status: "error" })).toBe(true);
		expect(canCheckForDesktopUpdate(downloading)).toBe(false);
		expect(reduceDesktopUpdateState(downloading, { type: "check" })).toBe(downloading);
		expect(reduceDesktopUpdateState(ready, { type: "error" })).toBe(ready);
	});
});
