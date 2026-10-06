import { describe, expect, mock, test } from "bun:test";
import {
	createNativeConfirmation,
	type NativeConfirmationRequest,
} from "@/platform/native-confirmation";

function harness() {
	const prompts: { confirm: () => void; cancel: () => void; failed: boolean }[] = [];
	const confirmation = createNativeConfirmation((_request, confirm, cancel, failed) => {
		prompts.push({ confirm, cancel, failed });
	});
	const onClose = mock(() => {});
	const request = (onConfirm: () => unknown): NativeConfirmationRequest => ({
		title: "Delete",
		description: "Delete item?",
		confirmLabel: "Delete",
		cancelLabel: "Cancel",
		destructive: true,
		onConfirm,
		onClose,
	});
	return { confirmation, prompts, request, onClose };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("native confirmation lifecycle", () => {
	test("duplicate taps and cancel cannot escape an in-flight action", async () => {
		const h = harness();
		let resolve: (() => void) | undefined;
		const action = mock(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		h.confirmation.open(h.request(action));
		h.prompts[0]?.confirm();
		h.prompts[0]?.confirm();
		h.prompts[0]?.cancel();
		expect(action).toHaveBeenCalledTimes(1);
		expect(h.onClose).not.toHaveBeenCalled();
		resolve?.();
		await settle();
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});
	test("failure keeps the same prompt available for a successful retry", async () => {
		const h = harness();
		let attempts = 0;
		h.confirmation.open(
			h.request(() => {
				if (++attempts === 1) throw new Error("private failure");
			}),
		);
		h.prompts[0]?.confirm();
		await settle();
		expect(h.onClose).not.toHaveBeenCalled();
		expect(h.prompts[1]?.failed).toBe(true);
		h.prompts[1]?.confirm();
		await settle();
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});
	test("replaced prompt callbacks cannot lock or complete a newer request", async () => {
		const h = harness();
		const old = mock(() => {});
		const fresh = mock(() => {});
		h.confirmation.open(h.request(old));
		h.confirmation.open(h.request(fresh));
		h.prompts[0]?.confirm();
		h.prompts[0]?.cancel();
		h.prompts[1]?.confirm();
		await settle();
		expect(old).not.toHaveBeenCalled();
		expect(fresh).toHaveBeenCalledTimes(1);
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});
	test("closing fences delayed success and delayed failure", async () => {
		for (const failure of [false, true]) {
			const h = harness();
			let finish: (() => void) | undefined;
			h.confirmation.open(
				h.request(
					() =>
						new Promise<void>((resolve, reject) => {
							finish = () => (failure ? reject(new Error("stale")) : resolve());
						}),
				),
			);
			h.prompts[0]?.confirm();
			h.confirmation.close();
			finish?.();
			await settle();
			expect(h.onClose).not.toHaveBeenCalled();
			expect(h.prompts).toHaveLength(1);
		}
	});
});
