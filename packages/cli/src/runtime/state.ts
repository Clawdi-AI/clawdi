import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { assertTrustedDirectory, ensureDirectoryWithinTrustedRoot } from "../lib/trusted-directory";
import type { HostPolicyReadResult } from "./host-policy";
import type { RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import {
	DEFAULT_CACHE_ROOT,
	DEFAULT_CONFIGURATION_ROOT,
	DEFAULT_RUN_ROOT,
	DEFAULT_SERVICE_STATE_ROOT,
	getRuntimePaths,
	type RuntimePaths,
} from "./paths";

export type RuntimeBootMode = "normal" | "degraded-offline" | "manifest-rejected" | "repair";
export type RuntimeBootStage = "detect" | "local" | "network" | "auth" | "config" | "final";

export interface RuntimeBootStatus {
	schemaVersion: "clawdi.runtimeBootStatus.v1";
	mode: RuntimeBootMode;
	status: "ok" | "error";
	stage: RuntimeBootStage;
	timestamp: string;
	bootId: string;
	runtimeMode: "local" | "hosted";
	activeGeneration: number | null;
	rejectedGeneration?: number | null;
	instanceId?: string | null;
	enabledRuntimes: string[];
	manifestSource?: {
		type: "remote-datasource" | "last-good-cache";
		path: string;
		offline: boolean;
	};
	convergence?: {
		workspaceRoot: string;
		managedConfig: string;
		syncState: string;
		instanceData: string;
		sensitiveInstanceData: string;
		manifestLastGood: string | null;
		appliedState: string | null;
		installInventory: string[];
		projections: string[];
		runConfigs: string[];
		processManager: "systemd";
		systemdSystemUnitRoot: string;
		systemdSystemUnits: string[];
		systemdUserUnitRoot: string;
		systemdUserUnits: string[];
		egressProfileBundle: string | null;
		egressSecretFile: string | null;
		egressEngine: RuntimeMitmproxyEnsureResult | null;
		egressTransparentEnv: string | null;
		egressAddon: string | null;
		liveSyncEnvironments: string[];
		daemonAuthTokenFile: string | null;
		instanceSemaphores: string[];
		bootFinished: string;
	};
	error?: string;
	errors: string[];
	exitCode: number;
	datasource: "RuntimeSource";
	hostPolicy: {
		source: "builtin" | "file";
		path?: string;
		exists: boolean;
		valid: boolean;
		mode?: string;
		cliUpdateMode?: string;
		error?: string;
	};
	paths: {
		hostPolicy: string;
		serviceStateRoot: string;
		managedConfig: string;
		syncState: string;
		manifestLastGood: string;
		appliedState: string;
		managedSecretCacheFile: string;
		runConfigRoot: string;
		egressProfileRoot: string;
		egressProfileBundle: string;
		systemdSystemRoot: string;
		systemdUserRoot: string;
		systemdEnvRoot: string;
		cliManagedBin: string;
		cliNpmPrefix: string;
		cliBootstrapStatus: string;
		cliUpgradeState: string;
		bootStatus: string;
		runtimeWatchStatus: string;
		cloudStatus: string;
		cloudResult: string;
		runRoot: string;
		managedSecretRoot: string;
		daemonAuthToken: string;
		instanceData: string;
		sensitiveInstanceData: string;
		projectionRoot: string;
		userHome: string;
		workspaceRoot: string;
	};
}

export interface RuntimeStatusRead {
	exists: boolean;
	source?: string;
	status?: RuntimeBootStatus;
	cloudStatus?: unknown;
	cloudResult?: unknown;
	error?: string;
}

function pathSummary(paths: RuntimePaths): RuntimeBootStatus["paths"] {
	return {
		hostPolicy: paths.hostPolicy,
		serviceStateRoot: paths.serviceStateRoot,
		managedConfig: paths.managedConfig,
		syncState: paths.syncState,
		manifestLastGood: paths.manifestLastGood,
		appliedState: paths.appliedState,
		managedSecretCacheFile: paths.managedSecretCacheFile,
		runConfigRoot: paths.runConfigRoot,
		egressProfileRoot: paths.egressProfileRoot,
		egressProfileBundle: paths.egressProfileBundle,
		systemdSystemRoot: paths.systemdSystemRoot,
		systemdUserRoot: paths.systemdUserRoot,
		systemdEnvRoot: paths.systemdEnvRoot,
		cliManagedBin: paths.cliManagedBin,
		cliNpmPrefix: paths.cliNpmPrefix,
		cliBootstrapStatus: paths.cliBootstrapStatus,
		cliUpgradeState: paths.cliUpgradeState,
		bootStatus: paths.bootStatus,
		runtimeWatchStatus: paths.runtimeWatchStatus,
		cloudStatus: paths.cloudStatus,
		cloudResult: paths.cloudResult,
		runRoot: paths.runRoot,
		managedSecretRoot: paths.managedSecretRoot,
		daemonAuthToken: paths.daemonAuthToken,
		instanceData: paths.instanceData,
		sensitiveInstanceData: paths.sensitiveInstanceData,
		projectionRoot: paths.projectionRoot,
		userHome: paths.userHome,
		workspaceRoot: paths.workspaceRoot,
	};
}

export function buildRuntimeBootStatus(
	partial: Omit<RuntimeBootStatus, "schemaVersion" | "timestamp" | "paths"> & {
		timestamp?: string;
		paths?: RuntimeBootStatus["paths"];
	},
	paths = getRuntimePaths(),
): RuntimeBootStatus {
	return {
		schemaVersion: "clawdi.runtimeBootStatus.v1",
		timestamp: partial.timestamp ?? new Date().toISOString(),
		paths: partial.paths ?? pathSummary(paths),
		...partial,
	};
}

export function hostPolicySummary(policy: HostPolicyReadResult): RuntimeBootStatus["hostPolicy"] {
	return {
		source: policy.source,
		...(policy.path ? { path: policy.path } : {}),
		exists: policy.exists,
		valid: policy.valid,
		mode: policy.policy?.mode,
		cliUpdateMode: policy.policy?.cliUpdateMode,
		error: policy.error,
	};
}

function writeJson(paths: RuntimePaths, path: string, data: unknown, mode = 0o600): void {
	writeRuntimePlatformFileAtomic(paths, path, `${JSON.stringify(data, null, 2)}\n`, {
		mode,
		dirMode: 0o755,
	});
}

export function runtimePlatformRoots(paths: RuntimePaths): string[] {
	return [paths.configurationRoot, paths.serviceStateRoot, paths.cacheRoot, paths.runRoot];
}

export function runtimePlatformRootForPath(paths: RuntimePaths, path: string): string | null {
	const resolvedPath = resolve(path);
	return (
		runtimePlatformRoots(paths)
			.map((root) => resolve(root))
			.filter((root) => {
				const candidate = relative(root, resolvedPath);
				return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
			})
			.sort((left, right) => right.length - left.length)[0] ?? null
	);
}

export function assertRuntimePlatformRoots(paths: RuntimePaths): void {
	for (const path of runtimePlatformRoots(paths)) {
		assertTrustedDirectory(path, "platform directory");
	}
}

export function ensureRuntimePlatformDirectory(
	paths: RuntimePaths,
	path: string,
	options: { mode?: number } = {},
): void {
	const root = runtimePlatformRootForPath(paths, path);
	if (!root) {
		throw new Error(`runtime platform directory is outside platform roots: ${path}`);
	}
	ensureDirectoryWithinTrustedRoot(root, path, options);
}

export function writeRuntimePlatformFileAtomic(
	paths: RuntimePaths,
	path: string,
	content: string | Uint8Array,
	options: { mode?: number; dirMode?: number } = {},
): void {
	const trustedRoot = runtimePlatformRootForPath(paths, path);
	if (!trustedRoot) {
		throw new Error(`runtime platform file is outside platform roots: ${path}`);
	}
	writePrivateFileAtomic(path, content, { ...options, trustedRoot });
}

export function ensureRuntimeStateDirs(paths = getRuntimePaths()): void {
	for (const [path, systemdPath, mode] of [
		[paths.configurationRoot, DEFAULT_CONFIGURATION_ROOT, 0o700],
		[paths.serviceStateRoot, DEFAULT_SERVICE_STATE_ROOT, 0o700],
		[paths.cacheRoot, DEFAULT_CACHE_ROOT, 0o700],
		// 0711 is deliberate: only named tenant handoff files below this root
		// are readable; private subtrees retain their narrower modes.
		[paths.runRoot, DEFAULT_RUN_ROOT, 0o711],
	] as const) {
		const created = !existsSync(path);
		if (created) {
			if (path === systemdPath) {
				throw new Error(`platform directory must be created by systemd: ${path}`);
			}
			mkdirSync(path, { recursive: true, mode });
		}
		assertTrustedDirectory(path, "platform directory");
		if (created) {
			// mkdir modes are filtered by umask, but these platform roots have an
			// exact access contract (including search access on the runtime root).
			chmodSync(path, mode);
		}
	}
	for (const [dir, mode] of [
		[paths.statusRoot, 0o755],
		[paths.instanceRoot, 0o755],
		[paths.installInventory, 0o755],
		[paths.projectionRoot, 0o755],
		[paths.runConfigRoot, 0o755],
		// Egress profile bundle handoff dir under the traversable run root:
		// 0711 lets the sidecar identity reach the named bundle without letting
		// any identity list the directory. Matches writeEgressAddon's dirMode.
		[paths.egressProfileRoot, 0o711],
		[paths.systemdSystemRoot, 0o755],
		[paths.systemdEnvRoot, 0o711],
		[dirname(paths.syncState), 0o755],
		[paths.managedSecretRoot, 0o711],
	] as const) {
		const platformRoot = runtimePlatformRootForPath(paths, dir);
		if (platformRoot) ensureDirectoryWithinTrustedRoot(platformRoot, dir, { mode });
		else assertTrustedDirectory(dir, "systemd platform directory");
	}
	mkdirSync(paths.systemdUserRoot, { recursive: true });
	assertRuntimePlatformRoots(paths);
}

export function writeRuntimeBootStatus(status: RuntimeBootStatus, paths = getRuntimePaths()): void {
	writeJson(paths, paths.bootStatus, status, 0o644);
	writeJson(
		paths,
		paths.cloudStatus,
		{
			v1: {
				datasource: status.datasource,
				status: status.status,
				extended_status: status.mode,
				stage: status.stage,
				boot_id: status.bootId,
				timestamp: status.timestamp,
				errors: status.errors,
			},
		},
		0o644,
	);
	writeJson(
		paths,
		paths.cloudResult,
		{
			v1: {
				datasource: status.datasource,
				status: status.status,
				mode: status.mode,
				stage: status.stage,
				exit_code: status.exitCode,
				boot_id: status.bootId,
				active_generation: status.activeGeneration,
				rejected_generation: status.rejectedGeneration ?? null,
				instance_id: status.instanceId ?? null,
				errors: status.errors,
			},
		},
		0o644,
	);
}

export function writeRuntimeWatchStatus(
	event: Record<string, unknown>,
	paths = getRuntimePaths(),
): void {
	writeJson(
		paths,
		paths.runtimeWatchStatus,
		{
			schemaVersion: "clawdi.runtimeWatchStatus.v1",
			timestamp: new Date().toISOString(),
			event,
		},
		0o644,
	);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function readRuntimeBootStatus(paths = getRuntimePaths()): RuntimeStatusRead {
	const read: RuntimeStatusRead = { exists: false };

	if (existsSync(paths.bootStatus)) {
		try {
			read.exists = true;
			read.source = paths.bootStatus;
			read.status = readJson<RuntimeBootStatus>(paths.bootStatus);
		} catch (e) {
			return {
				exists: true,
				source: paths.bootStatus,
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}

	if (existsSync(paths.cloudStatus)) {
		try {
			read.exists = true;
			read.cloudStatus = readJson<unknown>(paths.cloudStatus);
		} catch (e) {
			read.error = e instanceof Error ? e.message : String(e);
			read.source = paths.cloudStatus;
		}
	}

	if (existsSync(paths.cloudResult)) {
		try {
			read.exists = true;
			read.cloudResult = readJson<unknown>(paths.cloudResult);
		} catch (e) {
			read.error = e instanceof Error ? e.message : String(e);
			read.source = paths.cloudResult;
		}
	}

	return read;
}
