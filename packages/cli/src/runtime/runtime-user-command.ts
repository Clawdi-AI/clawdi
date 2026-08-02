import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, chownSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { withEffectiveFilesystemIdentity } from "./effective-identity";
import { applyEgressTransparentRuntimeEnv } from "./egress-env";
import { parsePositiveLinuxId } from "./transparent-egress";

export function executableExists(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function commandExists(name: string): boolean {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && executableExists(join(dir, name))) return true;
	}
	return false;
}

export function commandResolvable(command: string): boolean {
	return isAbsolute(command) ? executableExists(command) : commandExists(command);
}

export function runningAsRoot(): boolean {
	return typeof process.geteuid === "function" && process.geteuid() === 0;
}

export function runtimeUserUid(runtimeUser: string): number {
	const explicit = linuxUid(process.env.CLAWDI_RUNTIME_UID?.trim() ?? "");
	if (explicit !== null) return explicit;
	const numericUser = linuxUid(runtimeUser);
	if (numericUser !== null) return numericUser;
	const resolved = spawnSync("id", ["-u", runtimeUser], { encoding: "utf8" });
	if (resolved.status === 0) {
		const uid = linuxUid(resolved.stdout.trim());
		if (uid !== null) return uid;
	}
	if (runtimeUser === "clawdi") return 10_001;
	throw new Error(`could not resolve uid for ${runtimeUser}`);
}

function linuxUid(value: string): number | null {
	if (!/^(0|[1-9]\d*)$/.test(value)) return null;
	const uid = Number(value);
	return Number.isInteger(uid) && uid <= 4_294_967_295 ? uid : null;
}

function runtimeUserCommandEnv(
	home: string,
	options: { egressSystemCaFile?: string } = {},
): NodeJS.ProcessEnv {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null;
	const uid =
		runtimeUser && runtimeUser !== "root" && (runningAsRoot() || effectiveUid !== null)
			? String(runningAsRoot() ? runtimeUserUid(runtimeUser) : effectiveUid)
			: null;
	const runtimeDir = uid ? `/run/user/${uid}` : null;
	const env = {
		...process.env,
		HOME: home,
		PATH: [join(home, ".local", "bin"), join(home, ".openclaw", "bin"), process.env.PATH]
			.filter(Boolean)
			.join(":"),
		...(runtimeDir
			? {
					XDG_RUNTIME_DIR: runtimeDir,
					DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
				}
			: {}),
	};
	if (options.egressSystemCaFile) {
		applyEgressTransparentRuntimeEnv(env, { caFile: options.egressSystemCaFile });
	}
	return env;
}

export function runtimeUserGid(runtimeUser: string): number {
	const explicit = Number.parseInt(process.env.CLAWDI_RUNTIME_GID?.trim() ?? "", 10);
	if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 4_294_967_295) {
		return explicit;
	}
	const resolved = spawnSync("id", ["-g", runtimeUser], { encoding: "utf8" });
	if (resolved.status === 0) {
		const gid = Number.parseInt(resolved.stdout.trim(), 10);
		if (Number.isInteger(gid) && gid >= 0 && gid <= 4_294_967_295) return gid;
	}
	if (runtimeUser === "clawdi") return 10_001;
	throw new Error(`could not resolve runtime gid for ${runtimeUser}`);
}

export function runtimeEgressUid(): number {
	return positiveLinuxIdEnv("CLAWDI_EGRESS_UID", 10_002);
}

export function runtimeEgressGid(): number {
	return positiveLinuxIdEnv("CLAWDI_EGRESS_GID", 10_002);
}

function positiveLinuxIdEnv(key: string, fallback: number): number {
	const raw = process.env[key]?.trim();
	return raw ? parsePositiveLinuxId(raw, key) : fallback;
}

export function makeRuntimeUserOwned(path: string): void {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() ?? "";
	if (!runningAsRoot() || !runtimeUser || runtimeUser === "root") return;
	const resolved = spawnSync("id", ["-u", runtimeUser], { encoding: "utf8" });
	const group = spawnSync("id", ["-g", runtimeUser], { encoding: "utf8" });
	if (resolved.status !== 0 || group.status !== 0) return;
	const uid = Number.parseInt(resolved.stdout.trim(), 10);
	const gid = Number.parseInt(group.stdout.trim(), 10);
	if (!Number.isFinite(uid) || !Number.isFinite(gid)) return;
	try {
		chownSync(path, uid, gid);
	} catch {
		// Best effort for local development without the configured system user.
	}
}

export function withRuntimeUserFileAccess<T>(
	operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (!runningAsRoot() || !runtimeUser || runtimeUser === "root") return operation();
	const uid = runtimeUserUid(runtimeUser);
	const gid = runtimeUserGid(runtimeUser);
	if ((uid === 0 || gid === 0) && runtimeUser !== "0") {
		throw new Error(`runtime user ${runtimeUser} resolved to a root filesystem identity`);
	}
	return withEffectiveFilesystemIdentity({ uid, gid }, operation);
}

export function spawnRuntimeUserCommand(
	command: string,
	args: string[],
	home: string,
	cwd: string,
	options: {
		egressSystemCaFile?: string;
		input?: string;
		maxBufferBytes?: number;
		timeoutMs?: number;
	} = {},
): ReturnType<typeof spawnSync> {
	const env = runtimeUserCommandEnv(home, options);
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (runningAsRoot() && runtimeUser && runtimeUser !== "root") {
		if (commandExists("gosu")) {
			return spawnSync("gosu", [runtimeUser, command, ...args], {
				env: { ...env, USER: runtimeUser, LOGNAME: runtimeUser },
				cwd,
				encoding: "utf8",
				input: options.input,
				maxBuffer: options.maxBufferBytes,
				timeout: options.timeoutMs,
			});
		}
		if (commandExists("runuser")) {
			return spawnSync(
				"runuser",
				["-u", runtimeUser, "--", "env", `HOME=${home}`, `PATH=${env.PATH}`, command, ...args],
				{
					env,
					cwd,
					encoding: "utf8",
					input: options.input,
					maxBuffer: options.maxBufferBytes,
					timeout: options.timeoutMs,
				},
			);
		}
		throw new Error(
			`runtime init is running as root but cannot drop to CLAWDI_RUNTIME_USER=${runtimeUser}; install gosu or runuser`,
		);
	}
	return spawnSync(command, args, {
		env,
		cwd,
		encoding: "utf8",
		input: options.input,
		maxBuffer: options.maxBufferBytes,
		timeout: options.timeoutMs,
	});
}

export function runRuntimeUserCommand(
	command: string,
	args: string[],
	stdin: string,
	home: string,
	cwd: string,
	options: { egressSystemCaFile?: string; timeoutMs?: number } = {},
): void {
	const env = runtimeUserCommandEnv(home, options);
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (runningAsRoot() && runtimeUser && runtimeUser !== "root") {
		if (commandExists("gosu")) {
			execFileSync("gosu", [runtimeUser, command, ...args], {
				input: stdin,
				env: { ...env, USER: runtimeUser, LOGNAME: runtimeUser },
				cwd,
				stdio: "pipe",
				timeout: options.timeoutMs,
			});
			return;
		}
		if (commandExists("runuser")) {
			execFileSync(
				"runuser",
				["-u", runtimeUser, "--", "env", `HOME=${home}`, `PATH=${env.PATH}`, command, ...args],
				{ input: stdin, env, cwd, stdio: "pipe", timeout: options.timeoutMs },
			);
			return;
		}
		throw new Error(
			`runtime init is running as root but cannot drop to CLAWDI_RUNTIME_USER=${runtimeUser}; install gosu or runuser`,
		);
	}
	execFileSync(command, args, {
		input: stdin,
		env,
		cwd,
		stdio: "pipe",
		timeout: options.timeoutMs,
	});
}
