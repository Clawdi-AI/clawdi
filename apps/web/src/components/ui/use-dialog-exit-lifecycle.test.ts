import { describe, expect, test } from "bun:test";
import {
	type DialogExitState,
	dialogExitRenderedValue,
	reduceDialogExitState,
} from "./use-dialog-exit-lifecycle";

type SecretSnapshot = { secret: string | null; screen: "form" | "oauth" };

const empty: SecretSnapshot = { secret: null, screen: "form" };

describe("dialog exit lifecycle contract", () => {
	test("retains the rendered snapshot while closing and clears sensitive state on completion", () => {
		const open: DialogExitState<SecretSnapshot> = {
			phase: "open",
			snapshot: empty,
		};
		const closing = reduceDialogExitState(open, {
			type: "close",
			snapshot: { secret: "one-time-code", screen: "oauth" },
		});
		expect(closing).toEqual({
			phase: "closing",
			snapshot: { secret: "one-time-code", screen: "oauth" },
		});

		expect(reduceDialogExitState(closing, { type: "complete", emptySnapshot: empty })).toEqual({
			phase: "closed",
			snapshot: empty,
		});
	});

	test("close then reopen leaves the old snapshot out of the clean open phase", () => {
		const closing = reduceDialogExitState<SecretSnapshot>(
			{ phase: "open", snapshot: empty },
			{ type: "close", snapshot: { secret: "old", screen: "oauth" } },
		);
		const reopened = reduceDialogExitState(closing, { type: "open" });
		expect(reopened.phase).toBe("open");
		expect(dialogExitRenderedValue({ open: false, state: closing, value: empty })).toEqual({
			secret: "old",
			screen: "oauth",
		});
		expect(dialogExitRenderedValue({ open: true, state: closing, value: empty })).toEqual(empty);
	});
});
