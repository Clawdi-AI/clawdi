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
	windowsPathScript?: string;
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

/** Free the native launcher only when the old symlink belongs to Desktop.
 * lstat/readlink also recognize links to an app bundle that has been removed. */
export function removeDesktopCliSymlink(options: {
	home: string;
	userData: string;
	bundledCli: string;
}): void {
	const launcher = join(options.home, ".local", "bin", "clawdi");
	try {
		if (!lstatSync(launcher).isSymbolicLink()) return;
		const target = resolve(dirname(launcher), readlinkSync(launcher));
		if (
			target === resolve(options.bundledCli) ||
			isDesktopManagedTarget(target, options.userData)
		) {
			rmSync(launcher);
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

/** Keep an existing Desktop PATH entry working without editing PATH or
 * replacing a foreign command. Fresh native installs use the same ownership-marked launcher and PATH helper. */
export function migrateWindowsDesktopCliCommand(options: {
	localAppData?: string;
	target: string;
}): void {
	if (!options.localAppData || !isValidAbsolutePath(options.localAppData)) return;
	const launcher = join(options.localAppData, "Clawdi", "bin", "clawdi.cmd");
	try {
		const existing = readFileSync(launcher, "utf8");
		if (!existing.startsWith(`${WINDOWS_LAUNCHER_MARKER}\r\n`)) return;
		const content = windowsLauncherContent(options.target);
		if (existing !== content) writeLauncher(launcher, content);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

export async function reconcileWindowsNativeCliCommand(
	options: DesktopCliCommandOptions,
): Promise<void> {
	const launcher = defaultLauncherPath(options);
	try {
		lstatSync(launcher);
		migrateWindowsDesktopCliCommand({ localAppData: options.localAppData, target: options.target });
	} catch (error) {
		if (!isMissing(error)) throw error;
		await installDesktopCliCommand(options);
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

	installPosixLauncher(launcher, options);
	return {
		status: "installed",
		path: launcher,
		pathReady: pathContains(dirname(launcher), options.environmentPath, options.platform),
	};
}

/** Retain only our exact launcher for a native target whose ownership was verified. */
export async function removeWindowsDesktopCliCommand(options: {
	localAppData: string;
	windowsPathScript: string;
	retainedNativeTarget?: string;
	execute?: DesktopCliCommandOptions["execute"];
}): Promise<void> {
	const launcher = join(options.localAppData, "Clawdi", "bin", "clawdi.cmd");
	if (options.retainedNativeTarget) {
		try {
			if (readFileSync(launcher, "utf8") === windowsLauncherContent(options.retainedNativeTarget))
				return;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	await (options.execute ?? runCommand)("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		options.windowsPathScript,
		"-Action",
		"Remove",
		"-BinPath",
		dirname(launcher),
		"-LauncherPath",
		launcher,
	]);
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
	if (options.platform !== "win32") return join(options.home, ".local", "bin", "clawdi");
	const localAppData = options.localAppData?.trim();
	if (!localAppData || !isValidAbsolutePath(localAppData)) {
		throw new Error("The Windows user application directory is unavailable.");
	}
	return join(localAppData, "Clawdi", "bin", "clawdi.cmd");
}

function installPosixLauncher(launcher: string, options: DesktopCliCommandOptions): void {
	let existingTarget: string | null = null;
	try {
		const entry = lstatSync(launcher);
		if (!entry.isSymbolicLink()) throw new DesktopCliCommandConflictError(launcher);
		existingTarget = resolve(dirname(launcher), readlinkSync(launcher));
		if (normalize(existingTarget) === normalize(options.target)) return;
		if (!isDesktopManagedTarget(existingTarget, options.userData)) {
			throw new DesktopCliCommandConflictError(launcher);
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}

	mkdirSync(dirname(launcher), { recursive: true, mode: 0o755 });
	writeSymlink(launcher, options.target, existingTarget !== null);
}

async function installWindowsLauncher(
	launcher: string,
	options: DesktopCliCommandOptions,
): Promise<void> {
	const content = windowsLauncherContent(options.target);
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
	const script = options.windowsPathScript;
	if (!script || !isValidAbsolutePath(script) || !existsSync(script)) {
		throw new Error("The Windows CLI PATH helper is missing.");
	}
	await (options.execute ?? runCommand)("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-Action",
		"Add",
		"-BinPath",
		bin,
		"-LauncherPath",
		launcher,
	]);
}

function windowsLauncherContent(target: string): string {
	return `${WINDOWS_LAUNCHER_MARKER}\r\n@echo off\r\n"${escapeCmdPath(target)}" %*\r\n`;
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
	const root = normalize(resolve(userData, "runtimes"));
	const canonicalRoot = existsSync(userData)
		? normalize(resolve(realpathSync(userData), "runtimes"))
		: root;
	const normalized = normalize(existsSync(target) ? realpathSync(target) : resolve(target));
	const runtimeRoot = dirname(dirname(normalized));
	return (
		(runtimeRoot === root || runtimeRoot === canonicalRoot) && basename(normalized) === "clawdi"
	);
}

function isDesktopManagedTarget(target: string, userData: string): boolean {
	if (isAppImageRuntimeTarget(target, userData)) return true;
	const normalized = normalize(resolve(target)).replaceAll("\\", "/");
	return (
		/\/Clawdi\.app\/Contents\/Resources\/native\/clawdi$/.test(normalized) ||
		normalized === "/opt/Clawdi/resources/native/clawdi"
	);
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
