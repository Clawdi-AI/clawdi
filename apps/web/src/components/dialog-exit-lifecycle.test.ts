import { describe, expect, test } from "bun:test";
import {
	dialogExitRenderedValue,
	reduceDialogExitState,
} from "@/components/ui/use-dialog-exit-lifecycle";

describe("dialog exit lifecycle", () => {
	test("retains runtime credentials when an identity refresh programmatically closes the dialog", () => {
		const credentials = { username: "runtime-user", password: "one-time-secret" };
		const closing = reduceDialogExitState(
			{ phase: "open" as const, snapshot: null as typeof credentials | null },
			{ type: "close", snapshot: credentials },
		);
		expect(dialogExitRenderedValue({ open: false, state: closing, value: null })).toEqual(
			credentials,
		);
	});
});
