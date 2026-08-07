import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";
import {
	buildRuntimeUserCommand,
	commandExists,
	runningAsRoot,
	runtimeUserGid,
	runtimeUserUid,
} from "./runtime-user-command";

export const FILE_BROWSER_SERVICE_USER = "clawdi-files";
export const FILE_BROWSER_SERVICE_GROUP = "clawdi-files";

export interface FileBrowserServiceIdentity {
	uid: number;
	gid: number;
}

export type FileBrowserServiceIsolation = (
	paths: RuntimePaths,
	sourceRoot: string,
) => FileBrowserServiceIdentity;

interface PasswdEntry {
	uid: number;
	gid: number;
	home: string;
	shell: string;
}

function commandOutput(command: string, args: string[]): string {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024,
		timeout: 30_000,
	});
	if (result.status !== 0) {
		const detail = [result.error?.message, result.stderr, result.stdout]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n")
			.trim()
			.slice(-2000);
		throw new Error(
			`Files service isolation command failed: ${command}${detail ? `: ${detail}` : ""}`,
		);
	}
	return result.stdout.trim();
}

function lookupGroup(name: string): number | null {
	const result = spawnSync("getent", ["group", name], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const fields = result.stdout.trim().split(":");
	const gid = Number.parseInt(fields[2] ?? "", 10);
	if (!Number.isInteger(gid) || gid <= 0) {
		throw new Error(`Files service group ${name} has an invalid gid`);
	}
	return gid;
}

function lookupUser(name: string): PasswdEntry | null {
	const result = spawnSync("getent", ["passwd", name], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const fields = result.stdout.trim().split(":");
	const uid = Number.parseInt(fields[2] ?? "", 10);
	const gid = Number.parseInt(fields[3] ?? "", 10);
	if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
		throw new Error(`Files service user ${name} has an invalid filesystem identity`);
	}
	return { uid, gid, home: fields[5] ?? "", shell: fields[6] ?? "" };
}

function groupIdsForUser(name: string): number[] {
	const output = commandOutput("id", ["-G", name]);
	const gids = output.split(/\s+/).map((value) => Number.parseInt(value, 10));
	if (gids.length === 0 || gids.some((gid) => !Number.isInteger(gid) || gid <= 0)) {
		throw new Error(`Files service identity ${name} has invalid group membership`);
	}
	return [...new Set(gids)];
}

function groupNameForGid(gid: number): string {
	const result = spawnSync("getent", ["group", String(gid)], { encoding: "utf8" });
	const name = result.status === 0 ? result.stdout.trim().split(":")[0]?.trim() : "";
	if (!name) throw new Error(`Files service identity group ${gid} cannot be resolved`);
	return name;
}

function removeSupplementaryGroup(user: string, gid: number): void {
	commandOutput("gpasswd", ["--delete", user, groupNameForGid(gid)]);
}

function ensureServiceIdentity(runtimeUser: string): FileBrowserServiceIdentity {
	let gid = lookupGroup(FILE_BROWSER_SERVICE_GROUP);
	if (gid === null) {
		commandOutput("groupadd", ["--system", FILE_BROWSER_SERVICE_GROUP]);
		gid = lookupGroup(FILE_BROWSER_SERVICE_GROUP);
	}
	if (gid === null) throw new Error("Files service group was not created");

	let user = lookupUser(FILE_BROWSER_SERVICE_USER);
	if (user === null) {
		commandOutput("useradd", [
			"--system",
			"--gid",
			FILE_BROWSER_SERVICE_GROUP,
			"--home-dir",
			"/nonexistent",
			"--no-create-home",
			"--shell",
			"/usr/sbin/nologin",
			FILE_BROWSER_SERVICE_USER,
		]);
		user = lookupUser(FILE_BROWSER_SERVICE_USER);
	}
	if (user === null) throw new Error("Files service user was not created");
	const runtimeUid = runtimeUserUid(runtimeUser);
	const runtimeGid = runtimeUserGid(runtimeUser);
	if (user.uid === 0 || user.uid === runtimeUid || user.gid !== gid || user.gid === runtimeGid) {
		throw new Error("Files service identity is not distinct from the tenant runtime identity");
	}
	if (user.home !== "/nonexistent" || !user.shell.endsWith("/nologin")) {
		throw new Error("Files service identity must be non-login with no home directory");
	}
	if (groupIdsForUser(runtimeUser).includes(gid)) {
		removeSupplementaryGroup(runtimeUser, gid);
	}
	for (const supplementaryGid of groupIdsForUser(FILE_BROWSER_SERVICE_USER)) {
		if (supplementaryGid !== gid) {
			removeSupplementaryGroup(FILE_BROWSER_SERVICE_USER, supplementaryGid);
		}
	}
	if (
		groupIdsForUser(runtimeUser).includes(gid) ||
		groupIdsForUser(FILE_BROWSER_SERVICE_USER).some((memberGid) => memberGid !== gid)
	) {
		throw new Error("Files service identity has unsafe supplementary group membership");
	}
	return { uid: user.uid, gid };
}

function ensureWorkspaceAcl(
	paths: RuntimePaths,
	sourceRoot: string,
	runtimeUid: number,
	identity: FileBrowserServiceIdentity,
): void {
	if (!existsSync(sourceRoot)) {
		throw new Error(`Files source root does not exist: ${sourceRoot}`);
	}
	if (sourceRoot !== paths.userHome || /\s/.test(sourceRoot)) {
		throw new Error("Files source root must be the canonical tenant home path");
	}
	if (!commandExists("systemd-tmpfiles")) {
		throw new Error("Files service isolation requires systemd-tmpfiles");
	}
	if (!/(?:^|\s)\+ACL(?:\s|$)/.test(commandOutput("systemd-tmpfiles", ["--version"]))) {
		throw new Error("Files service isolation requires systemd-tmpfiles POSIX ACL support");
	}
	const runRoot = lstatSync(paths.runRoot);
	if (!runRoot.isDirectory() || runRoot.isSymbolicLink() || runRoot.uid !== 0) {
		throw new Error("Files service isolation requires a trusted root-owned runtime directory");
	}
	const temporaryRoot = mkdtempSync(paths.fileBrowserAclTempPrefix);
	chmodSync(temporaryRoot, 0o700);
	try {
		const config = join(temporaryRoot, "filebrowser.conf");
		const directoryAcl = [
			`u:${runtimeUid}:rwx`,
			`g:${identity.gid}:rwx`,
			"m::rwx",
			`d:u:${runtimeUid}:rwx`,
			`d:g:${identity.gid}:rwx`,
			"d:m::rwx",
		].join(",");
		const fileAcl = [`u:${runtimeUid}:rw-`, `g:${identity.gid}:rw-`, "m::rwx"].join(",");
		const contents = workspaceAclEntries(sourceRoot)
			.map(
				(entry) =>
					`a+ ${tmpfilesPath(entry.path)} - - - - ${entry.directory ? directoryAcl : fileAcl}`,
			)
			.join("\n");
		writePrivateFileAtomic(config, `${contents}\n`, {
			mode: 0o600,
			dirMode: 0o700,
		});
		commandOutput("systemd-tmpfiles", ["--create", config]);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
	for (const access of ["-r", "-w", "-x"]) {
		const command = buildRuntimeUserCommand(
			FILE_BROWSER_SERVICE_USER,
			"/nonexistent",
			"/usr/bin/test",
			[access, sourceRoot],
			{ currentUid: 0, runtimeUid: identity.uid, runtimeGid: identity.gid },
		);
		if (
			spawnSync(command.command, command.args, { env: { ...process.env, ...command.env } })
				.status !== 0
		) {
			throw new Error("Files service identity cannot access the tenant workspace ACL");
		}
	}
}

function workspaceAclEntries(sourceRoot: string): Array<{ path: string; directory: boolean }> {
	const root = lstatSync(sourceRoot);
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new Error("Files source root must be a trusted directory");
	}
	const entries: Array<{ path: string; directory: boolean }> = [
		{ path: sourceRoot, directory: true },
	];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isFile()) {
				entries.push({ path, directory: false });
				continue;
			}
			if (!stat.isDirectory() || stat.dev !== root.dev) continue;
			entries.push({ path, directory: true });
			visit(path);
		}
	};
	visit(sourceRoot);
	return entries;
}

function tmpfilesPath(path: string): string {
	let escaped = "";
	for (const byte of Buffer.from(path)) {
		if (byte === 0x25) {
			escaped += "%%";
			continue;
		}
		if (
			(byte >= 0x30 && byte <= 0x39) ||
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x61 && byte <= 0x7a) ||
			[0x2d, 0x2e, 0x2f, 0x5f].includes(byte)
		) {
			escaped += String.fromCharCode(byte);
			continue;
		}
		escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
	}
	return escaped;
}

function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) return null;
	return typeof error.code === "string" ? error.code : null;
}

export function ensureFileBrowserServiceIsolation(
	paths: RuntimePaths,
	sourceRoot: string,
): FileBrowserServiceIdentity {
	if (!runningAsRoot()) {
		throw new Error("Files service isolation requires root reconciliation");
	}
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	if (runtimeUser === "root" || runtimeUser === "0") {
		throw new Error("Files service isolation requires a non-root tenant runtime user");
	}
	for (const command of ["getent", "gpasswd", "groupadd", "id", "useradd"]) {
		if (!commandExists(command)) {
			throw new Error(`Files service isolation requires ${command}`);
		}
	}
	const identity = ensureServiceIdentity(runtimeUser);
	ensureWorkspaceAcl(paths, sourceRoot, runtimeUserUid(runtimeUser), identity);
	return identity;
}
