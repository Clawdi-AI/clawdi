import { execFileSync, spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	chownSync,
	constants,
	lchownSync,
	lstatSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withEffectiveFilesystemIdentity } from "./effective-identity";
import { applyEgressTransparentRuntimeEnv } from "./egress-env";
import { clearPlatformCredentialEnv } from "./platform-credential-env";
import { parsePositiveLinuxId } from "./transparent-egress";

const RUNTIME_IDENTITY_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface RuntimeUserIdentity {
	uid: number;
	gid: number;
}

export interface RuntimeOwnershipEnclave {
	path: string;
	owner: "root";
}

export interface RuntimeUserOwnershipRule {
	path: string;
	owner: "runtime-user" | "root";
	kind: "directory" | "existing";
	mode?: number;
	recursive: boolean;
	platformEnclaves?: readonly RuntimeOwnershipEnclave[];
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
		currentUid: options.currentUid ?? privilegeSourceUid(),
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
		currentUid: options.currentUid ?? privilegeSourceUid(),
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

function privilegeSourceUid(): number | undefined {
	const realUid = process.getuid?.();
	const effectiveUid = process.geteuid?.();
	// A shell child can restore a root real UID when only the effective UID was lowered.
	if (realUid === 0 || effectiveUid === 0) return 0;
	if (realUid !== undefined && effectiveUid !== undefined && realUid !== effectiveUid) {
		return undefined;
	}
	return effectiveUid ?? realUid;
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
	const tenantBinPaths = [join(home, ".local", "bin"), join(home, ".openclaw", "bin")];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		OPENCLAW_STATE_DIR: join(home, ".openclaw"),
		OPENCLAW_CONFIG_PATH: join(home, ".openclaw", "openclaw.json"),
		PATH:
			runtimeUid === null
				? [...tenantBinPaths, process.env.PATH].filter(Boolean).join(":")
				: runtimeUserSystemPath(tenantBinPaths),
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
	clearPlatformCredentialEnv(env);
	return env;
}

function runtimeUserSystemPath(tenantBinPaths: readonly string[]): string {
	const inheritedPath = process.env.PATH || DEFAULT_SYSTEM_PATH;
	const path = inheritedPath
		.split(":")
		.filter((entry) => entry && !tenantBinPaths.includes(entry))
		.join(":");
	return path || DEFAULT_SYSTEM_PATH;
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
	const explicit = linuxUid(process.env.CLAWDI_RUNTIME_GID?.trim() ?? "");
	if (explicit !== null) return explicit;
	const resolved = spawnSync("id", ["-g", runtimeUser], { encoding: "utf8" });
	if (resolved.status === 0) {
		const gid = linuxUid(resolved.stdout.trim());
		if (gid !== null) return gid;
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

export function runtimeUserDirectoryOwnership(
	path: string,
	options: {
		mode?: number;
		ancestorsUnder?: string;
		recursive?: boolean;
		platformEnclaves?: readonly RuntimeOwnershipEnclave[];
	} = {},
): RuntimeUserOwnershipRule[] {
	const target = resolve(path);
	const paths = [target];
	if (options.ancestorsUnder) {
		const boundary = resolve(options.ancestorsUnder);
		const relativeTarget = relative(boundary, target);
		if (relativeTarget === ".." || relativeTarget.startsWith("../") || isAbsolute(relativeTarget)) {
			throw new Error(`runtime-user directory is outside its ownership boundary: ${target}`);
		}
		for (let current = dirname(target); ; current = dirname(current)) {
			paths.push(current);
			if (current === boundary) break;
		}
	}
	const rules = runtimeUserOwnershipRules(paths, "directory", options, target);
	const platformEnclaves = normalizedPlatformEnclaves(target, options);
	return platformEnclaves.length === 0
		? rules
		: rules.map((rule) => (rule.path === target ? { ...rule, platformEnclaves } : rule));
}

function normalizedPlatformEnclaves(
	target: string,
	options: { recursive?: boolean; platformEnclaves?: readonly RuntimeOwnershipEnclave[] },
): RuntimeOwnershipEnclave[] {
	const enclaves = normalizeOwnershipEnclaves(options.platformEnclaves ?? []);
	if (enclaves.length > 0 && options.recursive !== true) {
		throw new Error("runtime-user platform enclaves require recursive ownership");
	}
	for (const enclave of enclaves) {
		const relativeEnclave = relative(target, enclave.path);
		if (
			!relativeEnclave ||
			relativeEnclave === ".." ||
			relativeEnclave.startsWith("../") ||
			isAbsolute(relativeEnclave)
		) {
			throw new Error(
				`runtime-user platform enclave is outside its ownership boundary: ${enclave.path}`,
			);
		}
	}
	return enclaves;
}

function normalizeOwnershipEnclaves(
	enclaves: readonly RuntimeOwnershipEnclave[],
): RuntimeOwnershipEnclave[] {
	const normalized = new Map<string, RuntimeOwnershipEnclave>();
	for (const enclave of enclaves) {
		const path = resolve(enclave.path);
		normalized.set(path, { path, owner: enclave.owner });
	}
	return [...normalized.values()].sort(
		(left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path),
	);
}

export const runtimeUserExistingOwnership = (
	paths: readonly string[],
	options: { recursive?: boolean } = {},
) => runtimeUserOwnershipRules(paths, "existing", options);

export function runtimePlatformEnclaveOwnership(
	enclaves: readonly RuntimeOwnershipEnclave[],
): RuntimeUserOwnershipRule[] {
	return normalizeOwnershipEnclaves(enclaves).map((enclave) => ({
		path: enclave.path,
		owner: enclave.owner,
		kind: "existing",
		recursive: true,
	}));
}

function runtimeUserOwnershipRules(
	paths: readonly string[],
	kind: RuntimeUserOwnershipRule["kind"],
	options: { mode?: number; recursive?: boolean },
	target?: string,
): RuntimeUserOwnershipRule[] {
	return [...new Set(paths.map((path) => resolve(path)))]
		.sort((left, right) => left.length - right.length || left.localeCompare(right))
		.map((path) => ({
			path,
			owner: "runtime-user",
			kind,
			...(path === target && options.mode !== undefined ? { mode: options.mode } : {}),
			recursive:
				target === undefined
					? options.recursive === true
					: path === target && options.recursive === true,
		}));
}

export function enforceRuntimeUserOwnership(
	rules: readonly RuntimeUserOwnershipRule[],
	identity?: RuntimeUserIdentity,
): void {
	if (rules.length === 0) return;
	const runtimeIdentity = runningAsRoot() ? (identity ?? runtimeFilesystemIdentity()) : null;
	const rootIdentity = runningAsRoot() ? { uid: 0, gid: 0 } : null;
	for (const rule of rules) {
		if (rule.kind === "directory") mkdirSync(rule.path, { recursive: true });
		let node: NonNullable<ReturnType<typeof lstatSync>>;
		try {
			node = lstatSync(rule.path);
		} catch (error) {
			if (rule.kind === "existing" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (rule.kind === "directory" && (!node.isDirectory() || node.isSymbolicLink())) {
			throw new Error(`runtime-user ownership path must be a real directory: ${rule.path}`);
		}
		enforceRuntimeUserNodeOwnership(
			rule.path,
			node,
			runtimeIdentity,
			rootIdentity,
			rule.owner,
			rule.recursive,
			new Map(rule.platformEnclaves?.map((enclave) => [enclave.path, enclave.owner]) ?? []),
		);
		if (rule.mode !== undefined) chmodSync(rule.path, rule.mode);
	}
}

export function enforceRuntimeUserSystemdManagerAccess(systemdUserRoot: string): void {
	if (!runningAsRoot()) return;
	let root: NonNullable<ReturnType<typeof lstatSync>>;
	try {
		root = lstatSync(systemdUserRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new Error(`runtime-user systemd root must be a real directory: ${systemdUserRoot}`);
	}
	ensureRuntimeUserManagerMode(systemdUserRoot, root, 0o555);
	for (const entry of readdirSync(systemdUserRoot, { withFileTypes: true })) {
		const path = join(systemdUserRoot, entry.name);
		if (entry.isFile() && entry.name.endsWith(".service")) {
			ensureRuntimeUserManagerMode(path, lstatSync(path), 0o444);
			continue;
		}
		if (!entry.isDirectory()) continue;
		if (entry.name === "default.target.wants") {
			ensureRuntimeUserManagerMode(path, lstatSync(path), 0o555);
			continue;
		}
		if (!entry.name.endsWith(".service.d")) continue;
		ensureRuntimeUserManagerMode(path, lstatSync(path), 0o555);
		for (const dropIn of readdirSync(path, { withFileTypes: true })) {
			if (!dropIn.isFile() || !dropIn.name.endsWith(".conf")) continue;
			const dropInPath = join(path, dropIn.name);
			ensureRuntimeUserManagerMode(dropInPath, lstatSync(dropInPath), 0o444);
		}
	}
}

function ensureRuntimeUserManagerMode(
	path: string,
	node: NonNullable<ReturnType<typeof lstatSync>>,
	requiredMode: number,
): void {
	const currentMode = Number(node.mode) & 0o7777;
	const nextMode = currentMode | requiredMode;
	if (nextMode !== currentMode) chmodSync(path, nextMode);
}

function runtimeFilesystemIdentity(): RuntimeUserIdentity | null {
	if (!runningAsRoot()) return null;
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (!runtimeUser || runtimeUser === "root" || runtimeUser === "0") return null;
	const identity = { uid: runtimeUserUid(runtimeUser), gid: runtimeUserGid(runtimeUser) };
	if (identity.uid === 0 || identity.gid === 0) {
		throw new Error(`runtime user ${runtimeUser} resolved to a root filesystem identity`);
	}
	return identity;
}

function enforceRuntimeUserNodeOwnership(
	path: string,
	node: NonNullable<ReturnType<typeof lstatSync>>,
	runtimeIdentity: RuntimeUserIdentity | null,
	rootIdentity: RuntimeUserIdentity | null,
	owner: RuntimeUserOwnershipRule["owner"],
	recursive: boolean,
	platformEnclaves: ReadonlyMap<string, RuntimeOwnershipEnclave["owner"]>,
): void {
	const effectiveOwner = platformEnclaves.get(path) ?? owner;
	const identity = effectiveOwner === "root" ? rootIdentity : runtimeIdentity;
	if (identity && (node.uid !== identity.uid || node.gid !== identity.gid)) {
		// lchown is non-dereferencing even if the path is swapped after lstat.
		lchownSync(path, identity.uid, identity.gid);
	}
	if (!recursive || !node.isDirectory() || node.isSymbolicLink()) return;
	for (const entry of readdirSync(path)) {
		const child = join(path, entry);
		enforceRuntimeUserNodeOwnership(
			child,
			lstatSync(child),
			runtimeIdentity,
			rootIdentity,
			effectiveOwner,
			true,
			platformEnclaves,
		);
	}
}

export function makeRuntimeUserOwned(path: string): void {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() ?? "";
	if (!runningAsRoot() || !runtimeUser || runtimeUser === "root") return;
	chownSync(path, runtimeUserUid(runtimeUser), runtimeUserGid(runtimeUser));
}

export function withRuntimeUserFileAccess<T>(
	operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
	identity?: RuntimeUserIdentity,
): T {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (!runningAsRoot() || !runtimeUser || runtimeUser === "root") return operation();
	const { uid, gid } = identity ?? {
		uid: runtimeUserUid(runtimeUser),
		gid: runtimeUserGid(runtimeUser),
	};
	if ((uid === 0 || gid === 0) && runtimeUser !== "0") {
		throw new Error(`runtime user ${runtimeUser} resolved to a root filesystem identity`);
	}
	return withEffectiveFilesystemIdentity({ uid, gid }, operation);
}

interface RuntimeUserCommandOptions {
	egressSystemCaFile?: string;
	environmentOverrides?: Readonly<Record<string, string | undefined>>;
	environment?: Record<string, string>;
	runtimeUser?: string;
	runtimeUid?: number;
	runtimeGid?: number;
	resolver?: PrivilegeDropResolver;
}

function runtimeUserCommand(
	command: string,
	args: string[],
	home: string,
	options: RuntimeUserCommandOptions,
) {
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
	const env = {
		...runtimeUserCommandEnv(home, runtimeUid, options),
		...child.env,
		...options.environment,
	};
	clearPlatformCredentialEnv(env);
	return { command: child.command, args: child.args, env };
}

export function spawnRuntimeUserCommand(
	command: string,
	args: string[],
	home: string,
	cwd: string,
	options: RuntimeUserCommandOptions & {
		input?: string;
		maxBufferBytes?: number;
		timeoutMs?: number;
	} = {},
): ReturnType<typeof spawnSync> {
	const child = runtimeUserCommand(command, args, home, options);
	return spawnSync(child.command, child.args, {
		env: child.env,
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
	options: RuntimeUserCommandOptions & {
		timeoutMs?: number;
	} = {},
): void {
	const child = runtimeUserCommand(command, args, home, options);
	try {
		execFileSync(child.command, child.args, {
			input: stdin,
			env: child.env,
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
