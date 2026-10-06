import { createActionGate } from "@/platform/auth/action-gate";

export type NativeConfirmationRequest = {
	title: string;
	description: string;
	confirmLabel: string;
	cancelLabel: string;
	destructive?: boolean;
	onConfirm: () => unknown;
	onClose: () => void;
};
export type ConfirmationPresenter = (
	request: NativeConfirmationRequest,
	confirm: () => void,
	cancel: () => void,
	failed: boolean,
) => void;

/** Native alerts dismiss on button press. Failed actions re-present the same prompt. */
export function createNativeConfirmation(present: ConfirmationPresenter) {
	const gate = createActionGate();
	let request: NativeConfirmationRequest | null = null;
	return {
		open(next: NativeConfirmationRequest) {
			gate.deactivate();
			gate.activate();
			request = next;
			const show = (failed: boolean) => {
				if (request !== next) return;
				present(
					next,
					() => {
						if (request !== next) return;
						const lease = gate.acquire();
						if (!lease) return;
						void (async () => {
							try {
								await next.onConfirm();
								if (lease.isCurrent()) {
									request = null;
									next.onClose();
								}
							} catch {
								if (lease.isCurrent()) {
									lease.release();
									show(true);
								}
							} finally {
								lease.release();
							}
						})();
					},
					() => {
						if (request !== next) return;
						const lease = gate.acquire();
						if (!lease) return;
						request = null;
						gate.deactivate();
						next.onClose();
					},
					failed,
				);
			};
			show(false);
		},
		close() {
			request = null;
			gate.deactivate();
		},
	};
}
