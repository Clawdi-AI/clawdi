import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HostPolicyReadResult } from "./host-policy";
import type { RuntimePaths } from "./paths";
import { getRuntimePaths } from "./paths";

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
		type: "fixture-file" | "remote-datasource" | "last-good-cache";
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
		installInventory: string[];
		projections: string[];
		runConfigs: string[];
		processManager: "systemd";
		systemdSystemUnitRoot: string;
		systemdSystemUnits: string[];
		systemdUserUnitRoot: string;
		systemdUserUnits: string[];
		mitmProfileBundle: string | null;
		mitmSecretFile: string | null;
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
		path: string;
		exists: boolean;
		valid: boolean;
		mode?: string;
		cliUpdateMode?: string;
		error?: string;
	};
	paths: {
		hostPolicy: string;
		runtimeSource: string;
		serviceStateRoot: string;
		managedConfig: string;
		syncState: string;
		manifestLastGood: string;
		managedSecretCacheFile: string;
		runConfigRoot: string;
		mitmProfileRoot: string;
		mitmProfileBundle: string;
		systemdSystemRoot: string;
		systemdUserRoot: string;
		systemdEnvRoot: string;
		cliManagedBin: string;
		cliNpmPrefix: string;
		cliBootstrapStatus: string;
		bootStatus: string;
		runtimeWatchStatus: string;
		cloudStatus: string;
		cloudResult: string;
		runRoot: string;
		managedSecretRoot: string;
		managedSecretFile: string;
		runtimeSecretFileRoot: string;
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
		runtimeSource: paths.runtimeSource,
		serviceStateRoot: paths.serviceStateRoot,
		managedConfig: paths.managedConfig,
		syncState: paths.syncState,
		manifestLastGood: paths.manifestLastGood,
		managedSecretCacheFile: paths.managedSecretCacheFile,
		runConfigRoot: paths.runConfigRoot,
		mitmProfileRoot: paths.mitmProfileRoot,
		mitmProfileBundle: paths.mitmProfileBundle,
		systemdSystemRoot: paths.systemdSystemRoot,
		systemdUserRoot: paths.systemdUserRoot,
		systemdEnvRoot: paths.systemdEnvRoot,
		cliManagedBin: paths.cliManagedBin,
		cliNpmPrefix: paths.cliNpmPrefix,
		cliBootstrapStatus: paths.cliBootstrapStatus,
		bootStatus: paths.bootStatus,
		runtimeWatchStatus: paths.runtimeWatchStatus,
		cloudStatus: paths.cloudStatus,
		cloudResult: paths.cloudResult,
		runRoot: paths.runRoot,
		managedSecretRoot: paths.managedSecretRoot,
		managedSecretFile: paths.managedSecretFile,
		runtimeSecretFileRoot: paths.runtimeSecretFileRoot,
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
		path: policy.path,
		exists: policy.exists,
		valid: policy.valid,
		mode: policy.policy?.mode,
		cliUpdateMode: policy.policy?.cliUpdateMode,
		error: policy.error,
	};
}

function writeJson(path: string, data: unknown, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode });
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort on filesystems without POSIX mode support.
	}
}

export function ensureRuntimeStateDirs(paths = getRuntimePaths()): void {
	for (const dir of [
		paths.cacheRoot,
		paths.bootRoot,
		paths.instanceRoot,
		paths.installInventory,
		paths.projectionRoot,
		paths.runConfigRoot,
		paths.mitmProfileRoot,
		paths.systemdSystemRoot,
		paths.systemdUserRoot,
		paths.systemdEnvRoot,
		dirname(paths.managedConfig),
		dirname(paths.syncState),
		paths.runRoot,
		paths.managedSecretRoot,
		paths.runtimeSecretFileRoot,
	]) {
		mkdirSync(dir, { recursive: true });
	}
}

export function writeRuntimeBootStatus(status: RuntimeBootStatus, paths = getRuntimePaths()): void {
	writeJson(paths.bootStatus, status, 0o644);
	writeJson(
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
