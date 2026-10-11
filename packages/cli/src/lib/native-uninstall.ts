import { execFileSync, spawn } from "node:child_process";
import {
	lstatSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readNativeExecutableIdentity } from "./native-activation";
import { detectNativeInstall, type NativeInstallOwnership } from "./native-distribution";

export function findNativeUninstallOwnership(home: string): NativeInstallOwnership | null {
	const running = detectNativeInstall(process.execPath);
	if (running) return running;
	const prefix = join(home, ".local");
	const root =
		process.platform === "win32"
			? join(prefix, "share", "clawdi", "current")
			: join(prefix, "bin", "clawdi");
	try {
		if (!lstatSync(root).isSymbolicLink()) return null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	const launcher = process.platform === "win32" ? join(root, "clawdi.exe") : root;
	const identity = readNativeExecutableIdentity(launcher);
	return identity ? detectNativeInstall(launcher, identity) : null;
}

const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function removeNativeCli(
	ownership: NativeInstallOwnership,
): Promise<{ status: "removed" | "scheduled"; message: string }> {
	// Recheck at the destructive boundary: never remove a replaced foreign launcher.
	if (!detectNativeInstall(ownership.launcher, ownership))
		throw new Error("Native launcher ownership changed");
	const nativeRoot = dirname(ownership.versionsRoot);
	if (process.platform === "win32") {
		const current = dirname(ownership.launcher);
		const running = realpathSync.native(process.execPath) === ownership.executable;
		const script = `$ErrorActionPreference = 'Stop'
$environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $raw = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts = @($raw -split ';' | Where-Object { $_.TrimEnd('\\') -ine ${powershellQuote(current)} })
  $environment.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally { $environment.Dispose() }`;
		execFileSync(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{ stdio: "pipe", timeout: 30_000, windowsHide: true },
		);
		rmdirSync(current); // Remove the junction only, never its target through the junction.
		if (running) {
			// Windows locks the running image. A separate OS process waits for exit before deletion.
			const cleanup = `$ErrorActionPreference = 'Stop'; Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${powershellQuote(nativeRoot)} -Recurse -Force`;
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					"powershell.exe",
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(cleanup, "utf16le").toString("base64"),
					],
					{ detached: true, stdio: "ignore", windowsHide: true },
				);
				child.once("error", reject);
				child.once("spawn", () => {
					child.unref();
					resolve();
				});
			});
			return {
				status: "scheduled",
				message:
					"Native CLI and PATH entry removed; locked version files will be deleted after this command exits.",
			};
		}
	} else {
		unlinkSync(ownership.launcher);
	}
	rmSync(nativeRoot, { recursive: true, force: true });
	return { status: "removed", message: "Native CLI versions and launcher removed." };
}

/** Match exactly the marker and guarded line emitted by install.sh, preserving all other text. */
export function removeNativeProfileBlocks(
	home: string,
	prefix: string,
): { status: "removed" | "skipped"; message: string } {
	if (process.platform === "win32")
		return { status: "skipped", message: "No shell profile blocks on Windows." };
	const marker = "# Added by the Clawdi installer (https://clawdi.ai/install.sh)";
	const bin = `${prefix}/bin`;
	const quoted = bin.replace(/[\\$`"]/g, "\\$&");
	const fishQuoted = bin.replace(/[\\$"]/g, "\\$&");
	const shellLine = `case ":$PATH:" in *":${quoted}:"*) ;; *) export PATH="${quoted}:$PATH" ;; esac`;
	const fishLine = `fish_add_path -g "${fishQuoted}"`;
	const profiles = new Set([
		join(home, ".bashrc"),
		join(home, ".bash_profile"),
		join(home, ".profile"),
		join(process.env.ZDOTDIR || home, ".zshrc"),
		join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "conf.d", "clawdi.fish"),
	]);
	let removed = 0;
	for (const path of profiles) {
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		const kept: string[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? "";
			const next = lines[index + 1]?.replace(/\r?\n$/, "");
			if (line.replace(/\r?\n$/, "") === marker && (next === shellLine || next === fishLine)) {
				index++;
				removed++;
			} else kept.push(line);
		}
		const updated = kept.join("");
		if (updated !== content) writeFileSync(path, updated);
	}
	return {
		status: removed ? "removed" : "skipped",
		message: `${removed} Clawdi installer PATH block(s) removed; other profile content kept.`,
	};
}
