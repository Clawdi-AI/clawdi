import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, chownSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { withEffectiveFilesystemIdentity } from "./effective-identity";
import { applyEgressTransparentRuntimeEnv } from "./egress-env";
import { parsePositiveLinuxId } from "./transparent-egress";

const RUNTIME_IDENTITY_PROBE_TIMEOUT_MS = 5_000;

export interface RuntimeUserIdentity {
	uid: number;
	gid: number;
}

export type RuntimeUserIdentityResolver = (runtimeUser: string) => RuntimeUserIdentity;

export class RuntimeUserCommandTimeoutError extends Error {
	constructor(
		readonly operation: string,
		readonly timeoutMs: number,
	) {
		super(`${operation} timed out after ${timeoutMs}ms`);
		this.name = "RuntimeUserCommandTimeoutError";
	}
}

export function executableExists(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function commandExists(name: string): boolean {
	const result = spawnSync("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name], {
		env: process.env,
		stdio: "ignore",
	});
	return result.status === 0;
}

export function commandResolvable(command: string): boolean {
	return isAbsolute(command) ? executableExists(command) : commandExists(command);
}

const PRIVILEGE_DROP_STRATEGIES = [
	{ mechanism: "setpriv", supportsNumericIdentity: true },
	{ mechanism: "runuser", supportsNumericIdentity: false },
	{ mechanism: "su", supportsNumericIdentity: false },
] as const;

type ExternalPrivilegeDropMechanism = (typeof PRIVILEGE_DROP_STRATEGIES)[number]["mechanism"];
export type PrivilegeDropMechanism = "none" | ExternalPrivilegeDropMechanism;
type PrivilegeDropTargetKind = "named" | "numeric";

interface PrivilegeDropResolutionInput {
	currentUid: number | undefined;
	targetUid: number;
	targetUser: string;
	targetKind: PrivilegeDropTargetKind;
}

export interface PrivilegeDropResolver {
	resolve(input: PrivilegeDropResolutionInput): PrivilegeDropMechanism;
}

export function createPrivilegeDropResolver(
	isCommandAvailable: (name: string) => boolean = commandExists,
): PrivilegeDropResolver {
	let resolved: ExternalPrivilegeDropMechanism | null | undefined;

	return {
		resolve(input): PrivilegeDropMechanism {
			if (input.currentUid === input.targetUid) return "none";
			if (input.currentUid !== 0) {
				throw new Error(`cannot drop privileges to ${input.targetUser}: no supported mechanism`);
			}

			if (resolved === undefined) {
				resolved = null;
				for (const strategy of PRIVILEGE_DROP_STRATEGIES) {
					if (isCommandAvailable(strategy.mechanism)) {
						resolved = strategy.mechanism;
						break;
					}
				}
			}

			const strategy = PRIVILEGE_DROP_STRATEGIES.find(
				(candidate) => candidate.mechanism === resolved,
			);
			if (
				resolved === null ||
				(input.targetKind === "numeric" && !strategy?.supportsNumericIdentity)
			) {
				throw new Error(`cannot drop privileges to ${input.targetUser}: no supported mechanism`);
			}
			return resolved;
		},
	};
}

const privilegeDropResolver = createPrivilegeDropResolver();

interface BuildRuntimeUserCommandOptions {
	currentUid?: number;
	runtimeUid?: number;
	runtimeGid?: number;
	resolver?: PrivilegeDropResolver;
	environment?: Record<string, string>;
}

interface RuntimeUserCommandDescriptor {
	command: string;
	args: string[];
	env: Record<string, string>;
}

export function buildRuntimeUserCommand(
	runtimeUser: string,
	home: string,
	command: string,
	args: string[],
	options: BuildRuntimeUserCommandOptions = {},
): RuntimeUserCommandDescriptor {
	const env = {
		...options.environment,
		HOME: home,
		USER: runtimeUser,
		LOGNAME: runtimeUser,
	};
	const childCommand = "env";
	const childArgs = [
		...Object.entries(env).map(([key, value]) => `${key}=${value}`),
		command,
		...args,
	];
	const runtimeUid = options.runtimeUid ?? runtimeUserUid(runtimeUser);
	const mechanism = (options.resolver ?? privilegeDropResolver).resolve({
		currentUid: options.currentUid ?? effectiveUid(),
		targetUid: runtimeUid,
		targetUser: runtimeUser,
		targetKind: "named",
	});
	if (mechanism === "none") return { command, args, env };
	if (mechanism === "setpriv") {
		const runtimeGid = options.runtimeGid ?? runtimeUserGid(runtimeUser);
		return {
			command: mechanism,
			args: [
				`--reuid=${runtimeUid}`,
				`--regid=${runtimeGid}`,
				"--init-groups",
				"--",
				childCommand,
				...childArgs,
			],
			env,
		};
	}
	if (mechanism === "runuser") {
		return {
			command: mechanism,
			args: ["--preserve-environment", "-u", runtimeUser, "--", childCommand, ...childArgs],
			env,
		};
	}
	return {
		command: mechanism,
		args: [
			"--preserve-environment",
			"--shell",
			"/bin/sh",
			"--command",
			'exec "$0" "$@"',
			runtimeUser,
			childCommand,
			...childArgs,
		],
		env,
	};
}

export function buildNumericUserCommand(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	options: { currentUid?: number; resolver?: PrivilegeDropResolver } = {},
): { command: string; args: string[] } {
	const targetUser = `${uid}:${gid}`;
	if (uid === 0 || gid === 0) {
		throw new Error(`cannot drop privileges to ${targetUser}: target identity must be non-root`);
	}
	const mechanism = (options.resolver ?? privilegeDropResolver).resolve({
		currentUid: options.currentUid ?? effectiveUid(),
		targetUid: uid,
		targetUser,
		targetKind: "numeric",
	});
	if (mechanism === "none") return { command, args };
	if (mechanism === "setpriv") {
		return {
			command: mechanism,
			args: [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--", command, ...args],
		};
	}
	throw new Error(`cannot drop privileges to ${targetUser}: no supported mechanism`);
}

export function runningAsRoot(): boolean {
	return typeof process.geteuid === "function" && process.geteuid() === 0;
}

function effectiveUid(): number | undefined {
	return process.geteuid?.() ?? process.getuid?.();
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

function strictRuntimeUserId(runtimeUser: string, kind: "uid" | "gid"): number {
	const flag = kind === "uid" ? "-u" : "-g";
	const resolved = spawnSync("id", [flag, runtimeUser], {
		encoding: "utf8",
		timeout: RUNTIME_IDENTITY_PROBE_TIMEOUT_MS,
	});
	if (resolved.error && "code" in resolved.error && resolved.error.code === "ETIMEDOUT") {
		throw new RuntimeUserCommandTimeoutError(
			`runtime user ${kind} probe for ${runtimeUser}`,
			RUNTIME_IDENTITY_PROBE_TIMEOUT_MS,
		);
	}
	if (resolved.status !== 0) {
		throw new Error(`could not resolve ${kind} for runtime user ${runtimeUser}`);
	}
	const parsed = linuxUid(resolved.stdout.trim());
	if (parsed === null) {
		throw new Error(`runtime user ${runtimeUser} resolved an invalid ${kind}`);
	}
	return parsed;
}

export function resolveRuntimeUserIdentity(runtimeUser: string): RuntimeUserIdentity {
	return {
		uid: strictRuntimeUserId(runtimeUser, "uid"),
		gid: strictRuntimeUserId(runtimeUser, "gid"),
	};
}

function runtimeUserCommandEnv(
	home: string,
	runtimeUid: number | null,
	options: {
		egressSystemCaFile?: string;
		environmentOverrides?: Readonly<Record<string, string | undefined>>;
	} = {},
): NodeJS.ProcessEnv {
	const runtimeDir = runtimeUid === null ? null : `/run/user/${runtimeUid}`;
	const env: NodeJS.ProcessEnv = {
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
	clearTenantToolLocationOverrides(env);
	for (const [key, value] of Object.entries(options.environmentOverrides ?? {})) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	if (options.egressSystemCaFile) {
		applyEgressTransparentRuntimeEnv(env, { caFile: options.egressSystemCaFile });
	}
	return env;
}

export function clearTenantToolLocationOverrides(env: NodeJS.ProcessEnv): void {
	for (const key of [
		"NPM_CONFIG_PREFIX",
		"npm_config_prefix",
		"NPM_CONFIG_CACHE",
		"npm_config_cache",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"HERMES_HOME",
		"UV_CACHE_DIR",
		"UV_PYTHON_INSTALL_DIR",
		"UV_PYTHON_BIN_DIR",
		"UV_TOOL_DIR",
		"UV_TOOL_BIN_DIR",
		"UV_MANAGED_PYTHON",
	] as const) {
		delete env[key];
	}
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
	chownSync(path, uid, gid);
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
		environmentOverrides?: Readonly<Record<string, string | undefined>>;
		environment?: Record<string, string>;
		input?: string;
		maxBufferBytes?: number;
		timeoutMs?: number;
		runtimeUser?: string;
		runtimeUid?: number;
		runtimeGid?: number;
		resolver?: PrivilegeDropResolver;
	} = {},
): ReturnType<typeof spawnSync> {
	const runtimeUser = options.runtimeUser ?? process.env.CLAWDI_RUNTIME_USER?.trim();
	const dropsToRuntimeUser = Boolean(runtimeUser && runtimeUser !== "root");
	const runtimeUid = dropsToRuntimeUser
		? (options.runtimeUid ?? runtimeUserUid(runtimeUser ?? ""))
		: null;
	const child = dropsToRuntimeUser
		? buildRuntimeUserCommand(runtimeUser ?? "", home, command, args, {
				runtimeUid: runtimeUid ?? undefined,
				runtimeGid: options.runtimeGid,
				resolver: options.resolver,
			})
		: { command, args, env: {} };
	return spawnSync(child.command, child.args, {
		env: {
			...runtimeUserCommandEnv(home, runtimeUid, options),
			...child.env,
			...options.environment,
		},
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
	options: {
		egressSystemCaFile?: string;
		timeoutMs?: number;
		runtimeUser?: string;
		runtimeUid?: number;
		runtimeGid?: number;
		resolver?: PrivilegeDropResolver;
	} = {},
): void {
	const runtimeUser = options.runtimeUser ?? process.env.CLAWDI_RUNTIME_USER?.trim();
	const dropsToRuntimeUser = Boolean(runtimeUser && runtimeUser !== "root");
	const runtimeUid = dropsToRuntimeUser
		? (options.runtimeUid ?? runtimeUserUid(runtimeUser ?? ""))
		: null;
	const child = dropsToRuntimeUser
		? buildRuntimeUserCommand(runtimeUser ?? "", home, command, args, {
				runtimeUid: runtimeUid ?? undefined,
				runtimeGid: options.runtimeGid,
				resolver: options.resolver,
			})
		: { command, args, env: {} };
	try {
		execFileSync(child.command, child.args, {
			input: stdin,
			env: { ...runtimeUserCommandEnv(home, runtimeUid, options), ...child.env },
			cwd,
			stdio: "pipe",
			timeout: options.timeoutMs,
		});
	} catch (error) {
		if (
			options.timeoutMs !== undefined &&
			error instanceof Error &&
			"code" in error &&
			error.code === "ETIMEDOUT"
		) {
			throw new RuntimeUserCommandTimeoutError(
				`runtime command ${command} ${args.join(" ")}`.trim(),
				options.timeoutMs,
			);
		}
		throw error;
	}
}
