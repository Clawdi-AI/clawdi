import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@clawdi/shared/api";
import { safeTruncate, sanitizeMetadata } from "../lib/sanitize";
import { getCliVersion } from "../lib/version";
import { toErrorMessage } from "../serve/log";
import { type RuntimeAppliedState, readRuntimeAppliedState } from "./applied-state";
import { resolveRuntimeApplyGeneration } from "./apply-identity";
import { type RuntimeCliBootstrapStatus, readRuntimeCliBootstrapStatus } from "./cli-update";
import { readHostedAgentPluginsObservation } from "./hosted-agent-plugin-observation";
import { providerHealthReasons } from "./manifest-providers";
import { hostedRuntimeBundleV2Schema } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { spawnRuntimeUserCommand } from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";
import { type RuntimeBootStatus, readRuntimeBootStatus } from "./state";
import { managedRuntimeSystemdUnitEntries, parseSystemctlShow, systemctlPath } from "./systemd";
import { runtimeUserName } from "./systemd-user";

type JsonRecord = Record<string, unknown>;
type ObservedStatus = "ok" | "error" | "unknown";
export type HostedRuntimeObserved = components["schemas"]["HostedRuntimeObservedV2"] &
	Pick<components["schemas"]["RuntimeObservationEventV2"], "agentPlugins">;
type HostedRuntimeObservedBoot = components["schemas"]["HostedRuntimeObservedBootV1"];
type HostedRuntimeObservedCli = components["schemas"]["HostedRuntimeObservedCliV1"];
type HostedRuntimeObservedProviderPayload =
	components["schemas"]["HostedRuntimeObservedProviderPayload"];
type HostedRuntimeObservedProviders = Record<string, HostedRuntimeObservedProviderPayload>;
type HostedRuntimeObservedSystemd = components["schemas"]["HostedRuntimeObservedSystemdV1"];
type HostedRuntimeObservedSystemdUnit = components["schemas"]["HostedRuntimeObservedSystemdUnitV1"];

const SYSTEMD_STATUS_TIMEOUT_MS = 1_000;
const SYSTEMD_FAILURE_EVIDENCE_MAX_LENGTH = 500;
const SYSTEMD_OBSERVED_UNIT_LIMIT = 30;
const SENSITIVE_FAILURE_EVIDENCE =
	/(?:^|[^a-z0-9])(?:api[_-]?key|key|token|secret|password|passwd|credential|authorization|bearer)(?:[^a-z0-9]|$)|(?:^|\s)[A-Z][A-Z0-9_]{1,}=|(?:^|[^a-z0-9])(?:sk-|gh[pousr]_|clawdi_)[a-z0-9_-]+/i;

export function readHostedRuntimeObserved(
	paths: RuntimePaths = getRuntimePaths(),
	options: {
		reportedAt?: string;
		appliedState?: RuntimeAppliedState | null;
		includeAgentPlugins?: boolean;
	} = {},
): HostedRuntimeObserved | null {
	if (paths.mode !== "hosted") return null;
	const boot = readRuntimeBootStatus(paths);
	const appliedState =
		options.appliedState === undefined ? readRuntimeAppliedState(paths) : options.appliedState;
	const watchStatus = readJsonRecord(paths.runtimeWatchStatus);
	const activeCliVersion = getCliVersion();
	const cliBootstrap = readRuntimeCliBootstrapStatus(paths);
	const systemd = readSystemdObserved(paths);
	const providers = readProviderObserved(paths);
	const appliedAuthority = appliedState
		? {
				etag: appliedState.etag,
				sourceRevision: appliedState.sourceRevision,
				generation: resolveRuntimeApplyGeneration(appliedState),
				instanceId: appliedState.instanceId,
				appliedProviderIds: [...appliedState.providerIds],
			}
		: null;

	const observed: HostedRuntimeObserved = {
		schemaVersion: "clawdi.hostedRuntimeObserved.v2",
		reportedAt: options.reportedAt ?? new Date().toISOString(),
		runtimeMode: paths.mode,
		status: observedStatus(boot.status, watchStatus, systemd, providers, appliedAuthority !== null),
		activeCliVersion,
		applied: appliedAuthority,
		boot: boot.status ? summarizeBootStatus(boot.status) : null,
		cli: observedCli(cliBootstrap),
	};
	if (systemd) {
		observed.systemd = systemd;
		if (systemd.unitCount > systemd.units.length) observed.truncated = true;
	}
	if (providers) observed.providers = providers;
	if (appliedState && options.includeAgentPlugins) {
		const agentPlugins = readHostedAgentPluginsObservation({
			paths,
			applied: appliedState,
			watchStatus,
		});
		if (agentPlugins) observed.agentPlugins = agentPlugins;
	}
	if (boot.error) observed.error = boot.error;
	const convergeError = runtimeConvergeError(watchStatus);
	if (convergeError) observed.convergeError = convergeError;
	return observed;
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
	systemd: HostedRuntimeObservedSystemd | null,
	providers: HostedRuntimeObservedProviders | null,
	hasAppliedAuthority: boolean,
): ObservedStatus {
	const watchEvent = recordValue(watchStatus?.event);
	if (bootStatus?.status === "error") return "error";
	if (systemd?.status === "error") return "error";
	if (providers && Object.values(providers).some((provider) => provider.status === "error")) {
		return "error";
	}
	if (
		watchEvent?.status === "error" &&
		(!hasAppliedAuthority || watchEvent.healthImpact !== "resource_projection")
	) {
		return "error";
	}
	if (!hasAppliedAuthority) return "unknown";
	if (systemd && systemdReadinessStatus(systemd.units) === "unknown") return "unknown";
	if (watchEvent?.status === "applied" || watchEvent?.status === "not_modified") return "ok";
	if (bootStatus?.status === "ok") return "ok";
	return "unknown";
}

function summarizeBootStatus(status: RuntimeBootStatus): HostedRuntimeObservedBoot {
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

function runtimeConvergeError(watchStatus: JsonRecord | null): string | null {
	const event = recordValue(watchStatus?.event);
	if (event?.status !== "error") return null;
	return (
		stringValue(event.error) ?? arrayValue(event.errors)[0]?.toString() ?? "runtime watch failed"
	);
}

function observedCli(value: RuntimeCliBootstrapStatus | null): HostedRuntimeObservedCli | null {
	if (!value) return null;
	return {
		status: value.status,
		source: value.source,
		packageSpec: value.packageSpec,
		registry: value.registry,
		activePath: value.activePath,
		activeTarget: value.activeTarget,
		version: value.version,
	};
}

function readProviderObserved(paths: RuntimePaths): HostedRuntimeObservedProviders | null {
	const cached = hostedRuntimeBundleV2Schema.safeParse(readJsonRecord(paths.manifestLastGood));
	const providers = recordValue(cached.success ? cached.data.manifest.projection?.providers : null);
	if (!providers || Object.keys(providers).length === 0) return null;

	const secrets = {
		...(readJsonRecord(paths.managedSecretCacheFile) ?? {}),
		...(readJsonRecord(join(paths.managedSecretRoot, "egress-secrets.json")) ?? {}),
	};
	const observed: HostedRuntimeObservedProviders = {};
	for (const providerId of Object.keys(providers).sort()) {
		const provider = recordValue(providers[providerId]);
		if (!provider) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		const secretAvailable =
			apiKeySecretRef === null ? null : providerSecretAvailable(secrets, apiKeySecretRef);
		const reasons = providerHealthReasons(provider, secretAvailable);
		observed[providerId] = {
			status: reasons.length > 0 ? "error" : "ok",
			configured: true,
			kind: stringValue(provider.kind),
			baseUrl: stringValue(provider.baseUrl),
			model: stringValue(provider.model),
			models: Array.isArray(provider.models) ? provider.models : undefined,
			apiKeySecretRef,
			secretAvailable,
			reasons,
		};
	}
	return Object.keys(observed).length > 0 ? observed : null;
}

function providerSecretAvailable(secrets: JsonRecord, ref: string): boolean {
	return runtimeSecretValue(secrets, ref) !== null;
}

function readSystemdObserved(paths: RuntimePaths): HostedRuntimeObservedSystemd | null {
	const systemUnits = managedSystemdUnitNames(paths.systemdSystemRoot).map((unit) =>
		systemdUnitStatus("system", unit, paths),
	);
	const userUnits = managedSystemdUnitNames(paths.systemdUserRoot).map((unit) =>
		systemdUnitStatus("user", unit, paths),
	);
	const allUnits = [...systemUnits, ...userUnits];
	if (allUnits.length === 0) return null;
	const units = representativeSystemdUnits(systemUnits, userUnits);
	return {
		status: systemdUnitsStatus(allUnits),
		unitCount: allUnits.length,
		units,
	};
}

function representativeSystemdUnits(
	systemUnits: HostedRuntimeObservedSystemdUnit[],
	userUnits: HostedRuntimeObservedSystemdUnit[],
): HostedRuntimeObservedSystemdUnit[] {
	const reservedForUser = Math.min(userUnits.length, SYSTEMD_OBSERVED_UNIT_LIMIT / 2);
	const systemLimit = Math.min(systemUnits.length, SYSTEMD_OBSERVED_UNIT_LIMIT - reservedForUser);
	const userLimit = Math.min(userUnits.length, SYSTEMD_OBSERVED_UNIT_LIMIT - systemLimit);
	return [...systemUnits.slice(0, systemLimit), ...userUnits.slice(0, userLimit)];
}

function managedSystemdUnitNames(root: string): string[] {
	return [...new Set(managedRuntimeSystemdUnitEntries(root).map((entry) => entry.unitName))].sort();
}

function systemdUnitStatus(
	scope: "system" | "user",
	unit: string,
	paths: RuntimePaths,
): HostedRuntimeObservedSystemdUnit {
	const result =
		scope === "system"
			? runSystemctl([
					"show",
					unit,
					"--property=ActiveState",
					"--property=SubState",
					"--property=Result",
					"--property=ExecMainCode",
					"--property=ExecMainStatus",
				])
			: runRuntimeUserSystemctl(paths, [
					"show",
					unit,
					"--property=ActiveState",
					"--property=SubState",
					"--property=Result",
					"--property=ExecMainCode",
					"--property=ExecMainStatus",
				]);
	const parsed = parseSystemctlShow(result.output);
	const status = systemdUnitObservedStatus(parsed.ActiveState, result.exitCode);
	return {
		scope,
		name: unit,
		activeState: parsed.ActiveState ?? "unknown",
		subState: parsed.SubState ?? "unknown",
		status,
		error:
			status === "error"
				? systemdFailureEvidence(scope, unit, parsed)
				: result.exitCode === 0
					? null
					: (nonSensitiveFailureEvidence(result.output) ?? "systemctl show failed"),
	};
}

function systemdFailureEvidence(
	scope: "system" | "user",
	unit: string,
	properties: Record<string, string>,
): string {
	const journal = runJournalctl([
		"--quiet",
		"--no-pager",
		"--output=cat",
		"--boot=0",
		"--priority=err",
		"--lines=20",
		scope === "system" ? "--unit" : "--user-unit",
		unit,
	]);
	if (journal.exitCode === 0) {
		const firstLine = journal.output.split(/\r?\n/).find((line) => line.trim());
		const evidence = firstLine ? nonSensitiveFailureEvidence(firstLine) : null;
		if (evidence) return evidence;
	}
	return (
		safeFailureEvidence(
			[
				`Result=${properties.Result || "unknown"}`,
				`ExecMainCode=${properties.ExecMainCode || "unknown"}`,
				`ExecMainStatus=${properties.ExecMainStatus || "unknown"}`,
			].join("; "),
		) ?? "Result=unknown; ExecMainCode=unknown; ExecMainStatus=unknown"
	);
}

function safeFailureEvidence(value: string): string | null {
	const line = sanitizeMetadata(value).replace(/\s+/g, " ").trim();
	return line ? safeTruncate(line, SYSTEMD_FAILURE_EVIDENCE_MAX_LENGTH) : null;
}

function nonSensitiveFailureEvidence(value: string): string | null {
	const evidence = safeFailureEvidence(value);
	return evidence && !SENSITIVE_FAILURE_EVIDENCE.test(evidence) ? evidence : null;
}

function runSystemctl(args: string[]): { exitCode: number | null; output: string } {
	const result = spawnSync(systemctlPath(), args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024,
		timeout: SYSTEMD_STATUS_TIMEOUT_MS,
	});
	return {
		exitCode: result.status,
		output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim(),
	};
}

function runJournalctl(args: string[]): { exitCode: number | null; output: string } {
	const result = spawnSync("journalctl", args, {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 64 * 1024,
		timeout: SYSTEMD_STATUS_TIMEOUT_MS,
	});
	return {
		exitCode: result.status,
		output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim(),
	};
}

function runRuntimeUserSystemctl(
	paths: RuntimePaths,
	args: string[],
): { exitCode: number | null; output: string } {
	const runtimeUser = runtimeUserName();
	try {
		const result = spawnRuntimeUserCommand(
			systemctlPath(),
			["--user", ...args],
			paths.userHome,
			paths.userHome,
			{
				runtimeUser,
				maxBufferBytes: 64 * 1024,
				timeoutMs: SYSTEMD_STATUS_TIMEOUT_MS,
			},
		);
		return {
			exitCode: result.status,
			output: [result.stdout, result.stderr, result.error?.message]
				.filter(Boolean)
				.join("\n")
				.trim(),
		};
	} catch (error) {
		return {
			exitCode: 1,
			output: toErrorMessage(error),
		};
	}
}

function systemdUnitsStatus(units: HostedRuntimeObservedSystemdUnit[]): ObservedStatus {
	if (units.some((unit) => unit.status === "error")) return "error";
	if (units.some((unit) => unit.status === "unknown")) return "unknown";
	return "ok";
}

function systemdReadinessStatus(units: HostedRuntimeObservedSystemdUnit[]): ObservedStatus {
	return systemdUnitsStatus(units.filter((unit) => !isRuntimeWatchRestartTransition(unit)));
}

function isRuntimeWatchRestartTransition(unit: HostedRuntimeObservedSystemdUnit): boolean {
	return (
		unit.scope === "system" &&
		unit.name === "clawdi-runtime-watch.service" &&
		unit.activeState === "activating" &&
		unit.subState === "auto-restart" &&
		unit.status === "unknown" &&
		unit.error === null
	);
}

function systemdUnitObservedStatus(
	activeState: string | undefined,
	exitCode: number | null,
): ObservedStatus {
	if (activeState === "failed" || activeState === "deactivating") return "error";
	if (exitCode !== 0) return "unknown";
	if (activeState === "active") return "ok";
	return "unknown";
}

function recordValue(value: unknown): JsonRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as JsonRecord;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
