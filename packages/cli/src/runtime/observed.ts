import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@clawdi/shared/api";
import { getCliVersion } from "../lib/version";
import { readRuntimeAppliedState } from "./applied-state";
import { normalizeSecretRef } from "./hosted-egress-profiles";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeBootStatus, readRuntimeBootStatus } from "./state";
import {
	isGeneratedRuntimeSystemdFile,
	runtimeUserName,
	runtimeUserSystemdEnvArgs,
} from "./systemd-user";

type JsonRecord = Record<string, unknown>;
type ObservedStatus = "ok" | "error" | "unknown";
type HostedRuntimeObserved = components["schemas"]["HostedRuntimeObservedV2"];
type HostedRuntimeObservedBoot = components["schemas"]["HostedRuntimeObservedBootV1"];
type HostedRuntimeObservedCli = components["schemas"]["HostedRuntimeObservedCliV1"];
type HostedRuntimeObservedProviderPayload =
	components["schemas"]["HostedRuntimeObservedProviderPayload"];
type HostedRuntimeObservedProviders = Record<string, HostedRuntimeObservedProviderPayload>;
type HostedRuntimeObservedSystemd = components["schemas"]["HostedRuntimeObservedSystemdV1"];
type HostedRuntimeObservedSystemdUnit = components["schemas"]["HostedRuntimeObservedSystemdUnitV1"];

const SYSTEMD_STATUS_TIMEOUT_MS = 1_000;

export function readHostedRuntimeObserved(
	paths: RuntimePaths = getRuntimePaths(),
): HostedRuntimeObserved | null {
	if (paths.mode !== "hosted") return null;
	const boot = readRuntimeBootStatus(paths);
	const appliedState = readRuntimeAppliedState(paths);
	const watchStatus = readJsonRecord(paths.runtimeWatchStatus);
	const cliBootstrap = readJsonRecord(paths.cliBootstrapStatus);
	const systemd = readSystemdObserved(paths);
	const providers = readProviderObserved(paths);
	const appliedAuthorityState =
		appliedState?.schemaVersion === "clawdi.runtimeAppliedState.v2" &&
		appliedState.etag &&
		appliedState.sourceRevision
			? appliedState
			: null;
	const appliedAuthority = appliedAuthorityState
		? {
				etag: appliedAuthorityState.etag ?? "",
				sourceRevision: appliedAuthorityState.sourceRevision ?? "",
				generation: appliedAuthorityState.generation,
				instanceId: appliedAuthorityState.instanceId,
				projectedProviderIds: [
					...new Set(Object.values(appliedAuthorityState.projectedProviderIds).flat()),
				].sort(),
			}
		: null;

	const observed: HostedRuntimeObserved = {
		schemaVersion: "clawdi.hostedRuntimeObserved.v2",
		reportedAt: new Date().toISOString(),
		runtimeMode: paths.mode,
		status: observedStatus(boot.status, watchStatus, systemd, providers, appliedAuthority !== null),
		activeCliVersion: getCliVersion(),
		applied: appliedAuthority,
		boot: boot.status ? summarizeBootStatus(boot.status) : null,
		cli: summarizeCliBootstrap(cliBootstrap),
	};
	if (systemd) observed.systemd = systemd;
	if (providers) observed.providers = providers;
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
	if (watchEvent?.status === "error") return "error";
	if (bootStatus?.status === "error") return "error";
	if (systemd?.status === "error") return "error";
	if (providers && Object.values(providers).some((provider) => provider.status === "error")) {
		return "error";
	}
	if (!hasAppliedAuthority) return "unknown";
	if (systemd?.status === "unknown") return "unknown";
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

function summarizeCliBootstrap(value: JsonRecord | null): HostedRuntimeObservedCli | null {
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

function readProviderObserved(paths: RuntimePaths): HostedRuntimeObservedProviders | null {
	const providerStatus = readJsonRecord(paths.providerHealthStatus);
	const statusProviders = recordValue(providerStatus?.providers);
	if (statusProviders && Object.keys(statusProviders).length > 0) {
		const observed: HostedRuntimeObservedProviders = {};
		for (const [providerId, value] of Object.entries(statusProviders)) {
			const provider = recordValue(value);
			if (provider) observed[providerId] = provider;
		}
		if (Object.keys(observed).length > 0) return observed;
	}

	const manifest = readJsonRecord(paths.manifestLastGood);
	const projection = recordValue(manifest?.projection);
	const providers = recordValue(projection?.providers);
	if (!providers || Object.keys(providers).length === 0) return null;

	const secrets = {
		...(readJsonRecord(paths.managedSecretFile) ?? {}),
		...(readJsonRecord(join(paths.managedSecretRoot, "egress-secrets.json")) ?? {}),
	};
	const observed: HostedRuntimeObservedProviders = {};
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
	const status = stringValue(provider.status);
	if (status && status !== "ok") {
		reasons.push(`provider_${status}`);
	}
	const error = recordValue(provider.error);
	const errorCode = error ? stringValue(error.code) : null;
	if (errorCode) {
		reasons.push(errorCode);
	}
	const baseUrl = stringValue(provider.baseUrl);
	if (!baseUrl) {
		reasons.push("base_url_missing");
	} else {
		try {
			const parsed = new URL(baseUrl);
			const apiMode = stringValue(provider.apiMode);
			if (isOpenAiCompatibleMode(apiMode) && (!parsed.pathname || parsed.pathname === "/")) {
				reasons.push("base_url_path_missing");
			}
		} catch {
			reasons.push("base_url_invalid");
		}
	}
	if (!stringValue(provider.model)) {
		reasons.push("model_missing");
	}
	if (stringValue(provider.apiKeySecretRef) && secretAvailable === false) {
		reasons.push("secret_missing");
	}
	if (provider.apiKeyRequired === true && !stringValue(provider.apiKeySecretRef)) {
		reasons.push("api_key_secret_ref_missing");
	}
	return reasons;
}

function isOpenAiCompatibleMode(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

function readSystemdObserved(paths: RuntimePaths): HostedRuntimeObservedSystemd | null {
	const systemUnits = managedSystemdUnitNames(paths.systemdSystemRoot).map((unit) =>
		systemdUnitStatus("system", unit, paths),
	);
	const userUnits = managedSystemdUnitNames(paths.systemdUserRoot).map((unit) =>
		systemdUnitStatus("user", unit, paths),
	);
	const units = [...systemUnits, ...userUnits].slice(0, 30);
	if (units.length === 0) return null;
	return {
		status: systemdUnitsStatus(units),
		unitCount: units.length,
		units,
	};
}

function managedSystemdUnitNames(root: string): string[] {
	if (!existsSync(root)) return [];
	const units = new Set<string>();
	for (const entry of readdirSync(root)) {
		if (entry.endsWith(".service")) {
			if (entry.startsWith("clawdi-") || isGeneratedSystemdPath(join(root, entry))) {
				units.add(entry);
			}
			continue;
		}
		if (!entry.endsWith(".service.d")) continue;
		const unitName = entry.slice(0, -".d".length);
		if (isGeneratedSystemdPath(join(root, entry, "10-clawdi-hosted.conf"))) {
			units.add(unitName);
		}
	}
	return [...units].sort();
}

function isGeneratedSystemdPath(path: string): boolean {
	try {
		return isGeneratedRuntimeSystemdFile(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

function systemdUnitStatus(
	scope: "system" | "user",
	unit: string,
	paths: RuntimePaths,
): HostedRuntimeObservedSystemdUnit {
	const result =
		scope === "system"
			? runSystemctl(["show", unit, "--property=ActiveState", "--property=SubState"])
			: runRuntimeUserSystemctl(paths, [
					"show",
					unit,
					"--property=ActiveState",
					"--property=SubState",
				]);
	const parsed = parseSystemctlShow(result.output);
	return {
		scope,
		name: unit,
		activeState: parsed.ActiveState ?? "unknown",
		subState: parsed.SubState ?? "unknown",
		status: systemdUnitObservedStatus(parsed.ActiveState, result.exitCode),
		error: result.exitCode === 0 ? null : result.output.slice(0, 500) || "systemctl show failed",
	};
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

function runRuntimeUserSystemctl(
	paths: RuntimePaths,
	args: string[],
): { exitCode: number | null; output: string } {
	const runtimeUser = runtimeUserName();
	if (process.getuid?.() === 0 && runtimeUser !== "root") {
		const uidResult = spawnSync("id", ["-u", runtimeUser], { encoding: "utf8" });
		const uid = uidResult.status === 0 ? (uidResult.stdout ?? "").trim() : "";
		if (!uid) {
			return {
				exitCode: uidResult.status ?? 1,
				output: `runtime user ${runtimeUser} uid lookup failed: ${
					[uidResult.stderr, uidResult.error?.message].filter(Boolean).join("\n").trim() ||
					"empty id output"
				}`,
			};
		}
		const result = spawnSync(
			"gosu",
			[
				runtimeUser,
				"env",
				...runtimeUserSystemdEnvArgs(paths, runtimeUser, uid),
				"systemctl",
				"--user",
				...args,
			],
			{
				encoding: "utf8",
				maxBuffer: 64 * 1024,
				timeout: SYSTEMD_STATUS_TIMEOUT_MS,
			},
		);
		return {
			exitCode: result.status,
			output: [result.stdout, result.stderr, result.error?.message]
				.filter(Boolean)
				.join("\n")
				.trim(),
		};
	}
	return runSystemctl(["--user", ...args]);
}

function systemctlPath(): string {
	return process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl";
}

function parseSystemctlShow(output: string): Record<string, string> {
	return Object.fromEntries(
		output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const index = line.indexOf("=");
				return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
			}),
	);
}

function systemdUnitsStatus(units: HostedRuntimeObservedSystemdUnit[]): ObservedStatus {
	if (units.some((unit) => unit.status === "error")) return "error";
	if (units.some((unit) => unit.status === "unknown")) return "unknown";
	return "ok";
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
