import { useLayoutEffect, useState } from "react";
import { createActionGate } from "@/platform/auth/action-gate";

export function useAuthAction(owner?: unknown) {
	const [gate] = useState(createActionGate);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	useLayoutEffect(() => {
		gate.activate(owner);
		setBusy(false);
		setError(false);
		return () => gate.deactivate();
	}, [gate, owner]);

	const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
		const lease = gate.acquire();
		if (!lease) return;
		setBusy(true);
		setError(false);
		try {
			await action(lease.isCurrent);
		} catch {
			if (lease.isCurrent()) setError(true);
		} finally {
			if (lease.isCurrent()) setBusy(false);
			lease.release();
		}
	};
	return { busy, error, run, clearError: () => setError(false) };
}
