/** Opt-in timing only: labels are caller-authored, never argv, payloads or errors. */
function begin(label: string): (() => void) | null {
	if (process.env.CLAWDI_RUNTIME_PROFILE !== "1") return null;
	const startedAt = Date.now();
	const started = performance.now();
	return () => {
		console.error(
			`CLAWDI_RUNTIME_SPAN ${JSON.stringify({
				label,
				pid: process.pid,
				startedAt,
				durationMs: Math.round((performance.now() - started) * 100) / 100,
			})}`,
		);
	};
}

export function profileRuntimeStep<T>(label: string, run: () => T): T {
	const finish = begin(label);
	try {
		return run();
	} finally {
		finish?.();
	}
}

export async function profileRuntimeStepAsync<T>(label: string, run: () => Promise<T>): Promise<T> {
	const finish = begin(label);
	try {
		return await run();
	} finally {
		finish?.();
	}
}
