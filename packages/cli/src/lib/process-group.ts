export interface ProcessTerminationOptions {
	termTimeoutMs: number;
	killTimeoutMs: number;
}

export interface ProcessTarget {
	readonly pid?: number;
	kill(signal: NodeJS.Signals): boolean;
}

export async function terminateProcessGroup(
	child: ProcessTarget,
	closed: Promise<void>,
	options: ProcessTerminationOptions,
): Promise<void> {
	signalProcessGroup(child, "SIGTERM");
	if (await waitForProcessExit(child, closed, options.termTimeoutMs)) return;
	signalProcessGroup(child, "SIGKILL");
	await waitForProcessExit(child, closed, options.killTimeoutMs);
}

function signalProcessGroup(child: ProcessTarget, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back to signalling the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The process may have closed between observation and signalling.
	}
}

async function waitForProcessExit(
	child: ProcessTarget,
	closed: Promise<void>,
	timeoutMs: number,
): Promise<boolean> {
	const pid = child.pid;
	if (process.platform === "win32" || !pid) return await waitForClose(closed, timeoutMs);
	if (!processGroupExists(pid)) return true;

	let poll: ReturnType<typeof setInterval> | undefined;
	const groupClosed = new Promise<void>((resolveClosed) => {
		poll = setInterval(() => {
			if (!processGroupExists(pid)) resolveClosed();
		}, 10);
	});
	try {
		return await waitForClose(groupClosed, timeoutMs);
	} finally {
		if (poll) clearInterval(poll);
	}
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const didClose = await Promise.race([
		closed.then(() => true),
		new Promise<false>((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout(false), timeoutMs);
		}),
	]);
	if (timer) clearTimeout(timer);
	return didClose;
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
