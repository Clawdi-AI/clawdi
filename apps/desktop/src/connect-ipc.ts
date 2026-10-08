interface SenderFrame {
	readonly url: string;
}

/** The parts of Electron's IpcMainInvokeEvent that identify the sender. */
interface ConnectIpcEvent {
	sender: { readonly mainFrame: SenderFrame };
	senderFrame: SenderFrame | null;
}

/**
 * Accepts IPC only from the Connect window's main frame at its exact local URL
 * (Electron security checklist: validate the sender of all IPC messages).
 */
export function assertConnectSender(
	event: ConnectIpcEvent,
	connectWebContents: ConnectIpcEvent["sender"] | null | undefined,
	connectUrl: string,
): void {
	if (!connectWebContents || event.sender !== connectWebContents)
		throw new Error("Unexpected Connect client.");
	const senderFrame = event.senderFrame;
	if (!senderFrame || senderFrame !== event.sender.mainFrame)
		throw new Error("Unexpected Connect frame.");
	if (senderFrame.url !== connectUrl) throw new Error("Unexpected Connect URL.");
}

/** The renderer may only remove a folder that is currently excluded. */
export function readExcludedProjectRemoval(value: unknown, current: readonly string[]): string {
	if (typeof value !== "string" || !current.includes(value)) {
		throw new Error("Choose an excluded project to remove.");
	}
	return value;
}

/** Re-checks the stored device verification page before handing it to the OS. */
export function verificationPageToOpen(uri: string | null): string | null {
	if (!uri) return null;
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
	return url.href;
}
