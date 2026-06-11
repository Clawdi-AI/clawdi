import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSecretRef } from "./hosted-mitm-profiles";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { readRuntimeBootStatus } from "./state";

type JsonRecord = Record<string, unknown>;
type ObservedStatus = "ok" | "error" | "unknown";

const SUPERVISOR_STATUS_TIMEOUT_MS = 1_000;
const SUPERVISOR_HARD_ERROR_STATES = new Set(["BACKOFF", "EXITED", "FATAL", "STOPPED", "UNKNOWN"]);
const SUPERVISOR_TRANSIENT_STATES = new Set(["STARTING", "STOPPING"]);

export function readHostedRuntimeObserved(
	paths: RuntimePaths = getRuntimePaths(),
): JsonRecord | null {
	if (paths.mode !== "hosted") return null;
	const boot = readRuntimeBootStatus(paths);
	const manifestEtag = readTrimmed(paths.manifestEtag);
	const channelsEtag = readTrimmed(paths.channelsEtag);
	const watchStatus = readJsonRecord(paths.runtimeWatchStatus);
	const cliBootstrap = readJsonRecord(paths.cliBootstrapStatus);
	const supervisor = readSupervisorObserved(paths);
	const providers = readProviderObserved(paths);

	const observed: JsonRecord = {
		schemaVersion: "clawdi.hostedRuntimeObserved.v1",
		reportedAt: new Date().toISOString(),
		runtimeMode: paths.mode,
		status: observedStatus(boot.status, watchStatus, supervisor, providers),
		manifest: {
			etag: manifestEtag,
			lastGoodExists: existsSync(paths.manifestLastGood),
		},
		channels: {
			etag: channelsEtag,
		},
		boot: boot.status ? summarizeBootStatus(boot.status) : null,
		watch: summarizeWatchStatus(watchStatus),
		cli: summarizeCliBootstrap(cliBootstrap),
	};
	if (supervisor) observed.supervisor = supervisor;
	if (providers) observed.providers = providers;
	if (boot.error) observed.error = boot.error;
	return observed;
}

function readTrimmed(path: string): string | null {
	try {
		const value = readFileSync(path, "utf-8").trim();
		return value || null;
	} catch {
		return null;
	}
}

function readJsonRecord(path: string): JsonRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as JsonRecord;
	} catch {
		return null;
	}
}

function observedStatus(
	bootStatus: { status: string; errors?: string[] } | undefined,
	watchStatus: JsonRecord | null,
	supervisor: JsonRecord | null,
	providers: JsonRecord | null,
): ObservedStatus {
	const watchEvent = recordValue(watchStatus?.event);
	if (watchEvent?.status === "error") return "error";
	if (bootStatus?.status === "error") return "error";
	if (supervisor?.status === "error") return "error";
	if (
		providers &&
		Object.values(providers).some((provider) => recordValue(provider)?.status === "error")
	) {
		return "error";
	}
	if (watchEvent?.status === "applied" || watchEvent?.status === "not_modified") return "ok";
	if (bootStatus?.status === "ok") return "ok";
	return "unknown";
}

function summarizeBootStatus(status: {
	status: string;
	mode: string;
	stage: string;
	timestamp: string;
	activeGeneration: number | null;
	instanceId?: string | null;
	enabledRuntimes: string[];
	errors: string[];
}): JsonRecord {
	return {
		status: status.status,
		mode: status.mode,
		stage: status.stage,
		timestamp: status.timestamp,
		activeGeneration: status.activeGeneration,
		instanceId: status.instanceId ?? null,
		enabledRuntimes: status.enabledRuntimes,
		errors: status.errors,
	};
}

function summarizeWatchStatus(status: JsonRecord | null): JsonRecord | null {
	if (!status) return null;
	const event = recordValue(status.event);
	return {
		timestamp: stringValue(status.timestamp),
		status: stringValue(event?.status),
		etag: stringValue(event?.etag),
		channelsEtag: stringValue(event?.channelsEtag),
		generation: numberValue(event?.generation),
		instanceId: stringValue(event?.instanceId),
		selfReexec: booleanValue(event?.selfReexec),
		error: stringValue(event?.error),
		errors: arrayValue(event?.errors),
		cliUpdate: summarizeCliUpdate(recordValue(event?.cliUpdate)),
	};
}

function summarizeCliUpdate(value: JsonRecord | null): JsonRecord | null {
	if (!value) return null;
	return {
		status: stringValue(value.status),
		packageSpec: stringValue(value.packageSpec),
		registry: stringValue(value.registry),
		activePath: stringValue(value.activePath),
		activeTarget: stringValue(value.activeTarget),
		version: stringValue(value.version),
	};
}

function summarizeCliBootstrap(value: JsonRecord | null): JsonRecord | null {
	if (!value) return null;
	return {
		status: stringValue(value.status),
		source: stringValue(value.source),
		packageSpec: stringValue(value.packageSpec),
		registry: stringValue(value.registry),
		activePath: stringValue(value.activePath),
		activeTarget: stringValue(value.activeTarget),
		version: stringValue(value.version),
	};
}

function readProviderObserved(paths: RuntimePaths): JsonRecord | null {
	const providerStatus = readJsonRecord(paths.providerHealthStatus);
	const statusProviders = recordValue(providerStatus?.providers);
	if (statusProviders && Object.keys(statusProviders).length > 0) {
		return statusProviders;
	}

	const manifest = readJsonRecord(paths.manifestLastGood);
	const projection = recordValue(manifest?.projection);
	const providers = recordValue(projection?.providers);
	if (!providers || Object.keys(providers).length === 0) return null;

	const secrets = readJsonRecord(join(paths.runRoot, "mitm", "secrets.json")) ?? {};
	const observed: JsonRecord = {};
	for (const providerId of Object.keys(providers).sort()) {
		const provider = recordValue(providers[providerId]);
		if (!provider) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		const secretAvailable =
			apiKeySecretRef === null ? null : providerSecretAvailable(secrets, apiKeySecretRef);
		const reasons = providerReasons(provider, secretAvailable);
		observed[providerId] = {
			status: reasons.length > 0 ? "error" : "ok",
			configured: true,
			kind: stringValue(provider.kind),
			baseUrl: stringValue(provider.baseUrl),
			model: stringValue(provider.model),
			apiKeySecretRef,
			secretAvailable,
			reasons,
		};
	}
	return Object.keys(observed).length > 0 ? observed : null;
}

function providerSecretAvailable(secrets: JsonRecord, ref: string): boolean {
	const normalized = normalizeSecretRef(ref);
	return Boolean(secrets[ref] || (normalized ? secrets[normalized] : undefined));
}

function providerReasons(provider: JsonRecord, secretAvailable: boolean | null): string[] {
	const reasons: string[] = [];
	const baseUrl = stringValue(provider.baseUrl);
	if (!baseUrl) {
		reasons.push("base_url_missing");
	} else {
		try {
			new URL(baseUrl);
		} catch {
			reasons.push("base_url_invalid");
		}
	}
	if (stringValue(provider.apiKeySecretRef) && secretAvailable === false) {
		reasons.push("secret_missing");
	}
	return reasons;
}

function readSupervisorObserved(paths: RuntimePaths): JsonRecord | null {
	if (!existsSync(paths.supervisorConfig)) return null;
	const socketPath = join(paths.runRoot, "supervisor.sock");
	if (!existsSync(socketPath)) {
		return {
			status: "unknown",
			available: false,
			socketExists: false,
			programs: [],
			error: "supervisor_socket_missing",
		};
	}

	const command = process.env.CLAWDI_SUPERVISORCTL_PATH?.trim() || "supervisorctl";
	const result = spawnSync(command, ["-c", paths.supervisorConfig, "status"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024,
		timeout: SUPERVISOR_STATUS_TIMEOUT_MS,
	});
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if (result.error) {
		return {
			status: "unknown",
			available: false,
			socketExists: true,
			programs: [],
			error: result.error.message,
		};
	}
	if (result.status !== 0) {
		return {
			status: "error",
			available: false,
			socketExists: true,
			exitCode: result.status,
			programs: [],
			error: output.slice(0, 1000) || "supervisorctl status failed",
		};
	}

	const programs = parseSupervisorStatus(output).slice(0, 20);
	return {
		status: supervisorProgramsStatus(programs),
		available: true,
		socketExists: true,
		programCount: programs.length,
		programs,
	};
}

function parseSupervisorStatus(output: string): JsonRecord[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map(parseSupervisorStatusLine);
}

function parseSupervisorStatusLine(line: string): JsonRecord {
	const match = /^(\S+)\s+([A-Z_]+)\s*(.*)$/.exec(line);
	if (!match) {
		return {
			name: line.slice(0, 120),
			state: "UNKNOWN",
			status: "error",
			description: null,
		};
	}
	const name = match[1] ?? line.slice(0, 120);
	const state = match[2] ?? "UNKNOWN";
	return {
		name,
		state,
		status: supervisorProgramStatus(state),
		description: match[3]?.trim() || null,
	};
}

function supervisorProgramsStatus(programs: JsonRecord[]): ObservedStatus {
	if (programs.some((program) => program.status === "error")) return "error";
	if (programs.some((program) => program.status === "unknown")) return "unknown";
	return "ok";
}

function supervisorProgramStatus(state: string): ObservedStatus {
	if (SUPERVISOR_HARD_ERROR_STATES.has(state)) return "error";
	if (SUPERVISOR_TRANSIENT_STATES.has(state)) return "unknown";
	if (state === "RUNNING") return "ok";
	return "unknown";
}

function recordValue(value: unknown): JsonRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as JsonRecord;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
