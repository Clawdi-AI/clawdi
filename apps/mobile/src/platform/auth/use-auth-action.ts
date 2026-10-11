import { useLayoutEffect, useState } from "react";
import { createActionGate } from "@/platform/auth/action-gate";

export function useAuthAction(owner?: unknown) {
	const [gate] = useState(createActionGate);
	const [busy, setBusy] = useState(false);
	// The last failure, kept so a surface can show its specific reason like Web's toasts.
	const [failure, setFailure] = useState<{ error: unknown } | null>(null);
	useLayoutEffect(() => {
		gate.activate(owner);
		setBusy(false);
		setFailure(null);
		return () => gate.deactivate();
	}, [gate, owner]);

	const runAction = async (
		action: (isCurrent: () => boolean) => Promise<void>,
		propagate = false,
	) => {
		const lease = gate.acquire();
		if (!lease) return;
		setBusy(true);
		setFailure(null);
		try {
			await action(lease.isCurrent);
		} catch (error) {
			if (lease.isCurrent()) setFailure({ error });
			if (propagate) throw error;
		} finally {
			if (lease.isCurrent()) setBusy(false);
			lease.release();
		}
	};
	return {
		busy,
		error: failure !== null,
		failure: failure?.error,
		run: (action: (isCurrent: () => boolean) => Promise<void>) => runAction(action),
		runOrThrow: (action: (isCurrent: () => boolean) => Promise<void>) => runAction(action, true),
		clearError: () => setFailure(null),
	};
}
