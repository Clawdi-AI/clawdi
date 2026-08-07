import { spawn } from "node:child_process";

export function browserOpenCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") {
		return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
	}
	return { command: "xdg-open", args: [url] };
}

/** Best-effort browser launch; callers always display a copyable URL too. */
export function openInBrowser(url: string): void {
	const { command, args } = browserOpenCommand(url);
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			/* opener missing — the user can copy the displayed URL */
		});
		child.unref();
	} catch {
		/* opener unavailable — the user can copy the displayed URL */
	}
}
