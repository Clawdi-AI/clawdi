import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { CommandOptions, CommandResult } from "./command-runner";
import { runCommand } from "./command-runner";

const WINDOWS_LAUNCHER_MARKER = "@rem Clawdi Desktop CLI launcher v1";

type SupportedPlatform = "darwin" | "linux" | "win32";

export interface DesktopCliCommandOptions {
	platform: SupportedPlatform;
	target: string;
	home: string;
	userData: string;
	localAppData?: string;
	environmentPath?: string;
	launcherPath?: string;
	execute?: (
		command: string,
		args: readonly string[],
		opts?: CommandOptions,
	) => Promise<CommandResult>;
}

export type DesktopCliCommandResult =
	| { status: "existing-command"; path: string }
	| { status: "installed"; path: string; pathReady: boolean };

export class DesktopCliCommandConflictError extends Error {
	constructor(readonly path: string) {
		super(`A different command already exists at ${path}.`);
	}
}

export async function installDesktopCliCommand(
	options: DesktopCliCommandOptions,
): Promise<DesktopCliCommandResult> {
	validateOptions(options);
	const launcher = options.launcherPath ?? defaultLauncherPath(options);
	const available = commandOnPath(options.platform, options.environmentPath);
	if (
		available &&
		normalizeForPlatform(available, options.platform) !==
			normalizeForPlatform(launcher, options.platform)
	) {
		return { status: "existing-command", path: available };
	}

	if (options.platform === "win32") {
		await installWindowsLauncher(launcher, options);
		return { status: "installed", path: launcher, pathReady: true };
	}

	await installPosixLauncher(launcher, options);
	return {
		status: "installed",
		path: launcher,
		pathReady: pathContains(dirname(launcher), options.environmentPath, options.platform),
	};
}

export function hasManagedAppImageCliCommand(options: {
	home: string;
	userData: string;
	launcherPath?: string;
}): boolean {
	return managedAppImageCliCommandTarget(options) !== null;
}

export function managedAppImageCliCommandTarget(options: {
	home: string;
	userData: string;
	launcherPath?: string;
}): string | null {
	const launcher = options.launcherPath ?? join(options.home, ".local", "bin", "clawdi");
	try {
		if (!lstatSync(launcher).isSymbolicLink()) return null;
		const target = resolve(dirname(launcher), readlinkSync(launcher));
		return isAppImageRuntimeTarget(target, options.userData) ? target : null;
	} catch {
		return null;
	}
}

function validateOptions(options: DesktopCliCommandOptions): void {
	const paths: Array<readonly [label: string, value: string]> = [
		["CLI target", options.target],
		["home directory", options.home],
		["Desktop data directory", options.userData],
	];
	if (options.launcherPath) paths.push(["launcher path", options.launcherPath]);
	for (const [label, value] of paths) {
		if (!value || !isValidAbsolutePath(value)) {
			throw new Error(`Invalid ${label}.`);
		}
	}
	if (!existsSync(options.target) || !lstatSync(options.target).isFile()) {
		throw new Error("The bundled Clawdi command is missing.");
	}
}

function defaultLauncherPath(options: DesktopCliCommandOptions): string {
	if (options.platform === "darwin") return "/usr/local/bin/clawdi";
	if (options.platform === "linux") return join(options.home, ".local", "bin", "clawdi");
	const localAppData = options.localAppData?.trim();
	if (!localAppData || !isValidAbsolutePath(localAppData)) {
		throw new Error("The Windows user application directory is unavailable.");
	}
	return join(localAppData, "Clawdi", "bin", "clawdi.cmd");
}

async function installPosixLauncher(
	launcher: string,
	options: DesktopCliCommandOptions,
): Promise<void> {
	let existingTarget: string | null = null;
	try {
		const entry = lstatSync(launcher);
		if (!entry.isSymbolicLink()) throw new DesktopCliCommandConflictError(launcher);
		existingTarget = resolve(dirname(launcher), readlinkSync(launcher));
		if (normalize(existingTarget) === normalize(options.target)) return;
		if (!isAppImageRuntimeTarget(existingTarget, options.userData)) {
			throw new DesktopCliCommandConflictError(launcher);
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}

	if (options.platform === "darwin" && !(await directoryIsWritable(dirname(launcher)))) {
		if (existingTarget) throw new DesktopCliCommandConflictError(launcher);
		const command = [
			`/bin/mkdir -p ${shellQuote(dirname(launcher))}`,
			`/bin/ln -s ${shellQuote(options.target)} ${shellQuote(launcher)}`,
		].join(" && ");
		await (options.execute ?? runCommand)(
			"/usr/bin/osascript",
			["-e", `do shell script ${appleScriptString(command)} with administrator privileges`],
			{ timeoutMs: 5 * 60_000 },
		);
		return;
	}

	mkdirSync(dirname(launcher), { recursive: true, mode: 0o755 });
	writeSymlink(launcher, options.target, existingTarget !== null);
}

async function installWindowsLauncher(
	launcher: string,
	options: DesktopCliCommandOptions,
): Promise<void> {
	const content = `${WINDOWS_LAUNCHER_MARKER}\r\n@echo off\r\n"${escapeCmdPath(options.target)}" %*\r\n`;
	if (existsSync(launcher)) {
		const existing = readFileSync(launcher, "utf8");
		if (!existing.startsWith(`${WINDOWS_LAUNCHER_MARKER}\r\n`)) {
			throw new DesktopCliCommandConflictError(launcher);
		}
		if (existing !== content) writeLauncher(launcher, content);
	} else {
		mkdirSync(dirname(launcher), { recursive: true });
		writeFileSync(launcher, content, { flag: "wx", mode: 0o755 });
	}

	const bin = dirname(launcher);
	if (pathContains(bin, options.environmentPath, options.platform)) return;
	const script = [
		"$bin = $env:CLAWDI_DESKTOP_CLI_BIN",
		"if ([string]::IsNullOrWhiteSpace($bin)) { throw 'Missing CLI directory.' }",
		"$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
		"$parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })",
		"if (-not ($parts | Where-Object { [StringComparer]::OrdinalIgnoreCase.Equals($_.TrimEnd('\\'), $bin.TrimEnd('\\')) })) {",
		"  [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')",
		"}",
	].join("; ");
	await (options.execute ?? runCommand)(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
		{ env: { ...process.env, CLAWDI_DESKTOP_CLI_BIN: bin } },
	);
}

function writeLauncher(path: string, content: string): void {
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(temporary, content, { flag: "wx", mode: 0o755 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function writeSymlink(path: string, target: string, replace: boolean): void {
	if (!replace) {
		symlinkSync(target, path);
		return;
	}
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		symlinkSync(target, temporary);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function commandOnPath(platform: SupportedPlatform, value = process.env.PATH): string | null {
	if (!value) return null;
	const names =
		platform === "win32" ? ["clawdi.exe", "clawdi.com", "clawdi.bat", "clawdi.cmd"] : ["clawdi"];
	for (const entry of value.split(platform === "win32" ? ";" : ":")) {
		const directory = stripPathQuotes(entry.trim());
		if (!directory || !isAbsolute(directory)) continue;
		for (const name of names) {
			const candidate = join(directory, name);
			try {
				if (!lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink()) continue;
				if (platform !== "win32") accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Continue searching PATH.
			}
		}
	}
	return null;
}

function pathContains(
	directory: string,
	value: string | undefined,
	platform: SupportedPlatform,
): boolean {
	if (!value) return false;
	const expected = normalizeForPlatform(directory, platform);
	return value
		.split(platform === "win32" ? ";" : ":")
		.map((entry) => stripPathQuotes(entry.trim()))
		.some((entry) => entry && normalizeForPlatform(entry, platform) === expected);
}

function normalizeForPlatform(path: string, platform: SupportedPlatform): string {
	const normalized = normalize(resolve(path));
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stripPathQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1)
		: value;
}

function isAppImageRuntimeTarget(target: string, userData: string): boolean {
	const root = normalize(resolve(realpathSync(userData), "runtimes"));
	const normalized = normalize(resolve(target));
	return dirname(dirname(normalized)) === root && basename(normalized) === "clawdi";
}

async function directoryIsWritable(path: string): Promise<boolean> {
	try {
		await access(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function appleScriptString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeCmdPath(value: string): string {
	if (/[\r\n%]/.test(value)) throw new Error("The bundled CLI path cannot be used by cmd.exe.");
	return value.replaceAll('"', '""');
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isValidAbsolutePath(value: string): boolean {
	return isAbsolute(value) && !value.includes("\0") && !/[\r\n]/.test(value);
}
