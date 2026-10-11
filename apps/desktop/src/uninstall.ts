import { execFileSync, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

export interface DesktopCleanupActions {
	prepare(): Promise<void>;
	revokeSessions(): Promise<void>;
	uninstallCli(removeCli: boolean): Promise<void>;
	removeCliCommand(removeCli: boolean): void | Promise<void>;
	clearData(): Promise<void>;
	removeLoginItem(): void;
}

interface DesktopUninstallActions extends DesktopCleanupActions {
	platform: NodeJS.Platform;
	installedByDesktop(): Promise<boolean>;
	showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
	removeApplication(removeCli: boolean): Promise<void>;
	quit(): void;
}

/** The native dialog is the sole confirmation; every cleanup step remains best effort. */
export async function uninstallDesktop(actions: DesktopUninstallActions): Promise<boolean> {
	const choice = await actions.showMessageBox({
		type: "warning",
		title: "Uninstall Clawdi",
		message: "Uninstall Clawdi from this computer?",
		detail:
			"Removes background sync, agent integrations, sign-in, and local app data. Your account data stays. A bundled fallback CLI is removed with the app.",
		checkboxLabel: "Also remove the Clawdi command-line tool",
		checkboxChecked: await actions.installedByDesktop(),
		buttons: ["Cancel", "Uninstall Clawdi"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	});
	if (choice.response !== 1) return false;
	const failed = await cleanupDesktop(actions, choice.checkboxChecked);
	try {
		await actions.removeApplication(choice.checkboxChecked);
	} catch {
		failed.push("Remove application");
	}
	try {
		if (failed.length) {
			await actions.showMessageBox({
				type: "warning",
				message: "Some uninstall steps couldn't finish",
				detail: `${failed.join("\n")}\nReinstall the CLI if needed, then run clawdi uninstall --yes. Your account data stays.`,
				buttons: ["Quit Clawdi"],
			});
		}
		if (actions.platform === "linux") {
			await actions.showMessageBox({
				type: "info",
				message: "Remove the Clawdi app",
				detail:
					"For a package install, run sudo apt remove clawdi-desktop or sudo dnf remove clawdi-desktop. For an AppImage, delete the downloaded file.",
				buttons: ["Quit Clawdi"],
			});
		}
	} finally {
		actions.quit();
	}
	return true;
}

/** Shared by the application menu and the real NSIS uninstall entry, never upgrades. */
export async function cleanupDesktop(
	actions: DesktopCleanupActions,
	removeCli: boolean,
): Promise<string[]> {
	const failed: string[] = [];
	const step = async (label: string, action: () => void | Promise<void>) => {
		try {
			await action();
		} catch {
			failed.push(label);
		}
	};
	await step("Stop app activity", actions.prepare);
	await step("Revoke Desktop sign-in", actions.revokeSessions);
	await step("Remove local services and integrations", () => actions.uninstallCli(removeCli));
	await step("Remove Desktop CLI launcher", () => actions.removeCliCommand(removeCli));
	await step("Remove login item", actions.removeLoginItem);
	await step("Clear local app data", actions.clearData);
	return failed;
}

export function macApplicationBundle(executable: string): string {
	const bundle = dirname(dirname(dirname(executable)));
	if (!bundle.endsWith(".app")) throw new Error("Clawdi app bundle was not found");
	return bundle;
}

export async function launchWindowsUninstaller(
	executable: string,
	removeCli: boolean,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(windowsUninstaller(executable), removeCli ? [] : ["/KEEPCLI"], {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export function windowsUninstaller(executable: string): string {
	return join(dirname(executable), "Uninstall Clawdi.exe");
}

/** Windows keeps Chromium files locked until exit. Deletion follows process termination. */
export async function clearDesktopDirectories(
	paths: readonly string[],
	platform = process.platform,
): Promise<void> {
	if (platform !== "win32") {
		for (const path of new Set(paths)) await rm(path, { recursive: true, force: true });
		return;
	}
	const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const script = `$ErrorActionPreference = 'Stop'; Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try { ${[...new Set(paths)].map((path) => `if (Test-Path -LiteralPath ${quote(path)}) { Remove-Item -LiteralPath ${quote(path)} -Recurse -Force }`).join("; ")}; break }
  catch { if ($attempt -eq 39) { throw }; Start-Sleep -Milliseconds 250 }
}`;
	const launch = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}' -WindowStyle Hidden`;
	execFileSync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(launch, "utf16le").toString("base64"),
		],
		{ stdio: "pipe", timeout: 30_000, windowsHide: true },
	);
}
