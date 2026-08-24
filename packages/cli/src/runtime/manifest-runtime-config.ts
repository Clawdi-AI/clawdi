import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import {
	getHermesRawConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "./hermes-config";
import { mergeRuntimeEnvWithProviderPlaceholders } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import type { RuntimeName, RuntimeRunSettings, RuntimeServiceName } from "./run-config";
import { executableExists } from "./runtime-user-command";

const MANAGED_LOCALE_BLOCK_START = "<!-- >>> clawdi managed locale >>>";
const MANAGED_LOCALE_BLOCK_END = "<!-- <<< clawdi managed locale <<< -->";
export function managedLocaleBlock(locale: NonNullable<RuntimeManifest["locale"]>): string {
	return [
		MANAGED_LOCALE_BLOCK_START,
		"## Clawdi managed locale",
		"",
		`Use \`${locale.language}\` as the default response language unless the user explicitly requests another language.`,
		`Interpret ambiguous dates and times in \`${locale.timezone}\` unless the user specifies another timezone.`,
		MANAGED_LOCALE_BLOCK_END,
	].join("\n");
}
export function nextManagedLocaleFileContent(
	path: string,
	block: string,
): {
	existing: string;
	next: string;
} {
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const start = existing.indexOf(MANAGED_LOCALE_BLOCK_START);
	const end = existing.indexOf(MANAGED_LOCALE_BLOCK_END);
	const hasStart = start !== -1;
	const hasEnd = end !== -1;
	if (hasStart !== hasEnd || (hasStart && end < start)) {
		throw new Error(`managed locale block markers are malformed in ${path}`);
	}
	if (
		hasStart &&
		(existing.indexOf(MANAGED_LOCALE_BLOCK_START, start + MANAGED_LOCALE_BLOCK_START.length) !==
			-1 ||
			existing.indexOf(MANAGED_LOCALE_BLOCK_END, end + MANAGED_LOCALE_BLOCK_END.length) !== -1)
	) {
		throw new Error(`managed locale block markers are duplicated in ${path}`);
	}

	let next: string;
	if (hasStart && hasEnd) {
		const suffixStart = end + MANAGED_LOCALE_BLOCK_END.length;
		next = `${existing.slice(0, start)}${block}${existing.slice(suffixStart)}`;
	} else {
		const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		next = `${existing}${separator}${block}\n`;
	}

	return { existing, next };
}
function updateManagedLocaleFile(path: string, block: string): string {
	const { existing, next } = nextManagedLocaleFileContent(path, block);
	if (next === existing) return path;
	writePrivateFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 });
	return path;
}
export function hermesConfigContext(
	observation: RuntimeInstallObservation,
	home: string,
	cwd: string,
): HermesConfigCommandContext {
	if (!observation.commandPath || !executableExists(observation.commandPath)) {
		throw new Error("Hermes config command is unavailable");
	}
	return { command: observation.commandPath, home, cwd };
}
function applyHermesDashboardConfig(
	context: HermesConfigCommandContext,
	auth: NonNullable<RuntimeManifest["hermesDashboardAuth"]>,
): void {
	reconcileHermesConfigValue(context, "dashboard.basic_auth", {
		username: auth.username,
		session_ttl_seconds: auth.sessionTtlSeconds,
	});
	reconcileHermesConfigValue(context, "dashboard.public_url", auth.publicUrl);
	const currentDisabled = getHermesRawConfigValue(context, "plugins.disabled");
	if (
		currentDisabled.exists &&
		(!Array.isArray(currentDisabled.value) ||
			currentDisabled.value.some((value) => typeof value !== "string"))
	) {
		throw new Error("Hermes config field plugins.disabled must be a string array");
	}
	const disabled = new Set(
		(currentDisabled.exists ? (currentDisabled.value as string[]) : []).filter(
			(value) => value !== "dashboard_auth/basic",
		),
	);
	disabled.add("dashboard_auth/nous");
	disabled.add("dashboard_auth/self_hosted");
	reconcileHermesConfigValue(context, "plugins.disabled", [...disabled].sort());
}
export function applyHostedRuntimeConfigProjection(
	runtime: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
	workspaceRoot: string,
): string | null {
	if (manifest.runtimes[runtime]?.enabled !== true) return null;
	const locale = manifest.locale;
	if (runtime === "openclaw") {
		if (!openClawWorkspaceRoot) throw new Error("OpenClaw official agent workspace is unavailable");
		return locale
			? updateManagedLocaleFile(join(openClawWorkspaceRoot, "SOUL.md"), managedLocaleBlock(locale))
			: null;
	}
	if (runtime === "hermes") {
		const auth = manifest.hermesDashboardAuth;
		const context = hermesConfigContext(observation, home, workspaceRoot);
		const hermesHome = join(home, ".hermes");
		reconcileHermesConfigValue(context, "terminal.cwd", workspaceRoot);
		if (auth) applyHermesDashboardConfig(context, auth);
		if (locale) reconcileHermesConfigValue(context, "timezone", locale.timezone);
		return locale
			? updateManagedLocaleFile(join(hermesHome, "SOUL.md"), managedLocaleBlock(locale))
			: null;
	}
	return null;
}
export function resolvedRuntimeServiceSettings(
	manifest: RuntimeManifest,
	runtime: RuntimeName,
	service: RuntimeServiceName,
	settings: RuntimeRunSettings,
	providerEnv: Record<string, string>,
): RuntimeRunSettings {
	const merged = mergeRuntimeEnvWithProviderPlaceholders(runtime, settings, providerEnv, service);
	return runtime === "hermes" && service === "dashboard"
		? (withHermesDashboardAuthEnvironment(manifest, merged) ?? merged)
		: merged;
}
export function resolvedRuntimeSettings(
	runtime: string,
	settings: RuntimeRunSettings | undefined,
	providerEnv: Record<string, string>,
): RuntimeRunSettings | undefined {
	return mergeRuntimeEnvWithProviderPlaceholders(runtime, settings, providerEnv);
}
export function mergeRuntimeSecretEnv(
	runtimeName: string,
	settings: RuntimeRunSettings | undefined,
	providerSecretEnv: Record<string, string>,
	serviceName?: string,
): Record<string, string> {
	const scope = `runtime ${runtimeName}${serviceName ? ` service ${serviceName}` : ""}`;
	const merged = { ...providerSecretEnv };
	const runtimeSecretEnv = settings?.secretEnv ?? {};
	for (const [envName, ref] of Object.entries(runtimeSecretEnv)) {
		const existing = merged[envName];
		if (existing !== undefined && existing !== ref) {
			throw new Error(
				`${scope} secretEnv.${envName} conflicts with provider secret ref ${existing}`,
			);
		}
		merged[envName] = ref;
	}
	for (const envName of Object.keys(settings?.env ?? {})) {
		if (merged[envName] !== undefined) {
			throw new Error(`${scope} defines ${envName} in both env and secretEnv`);
		}
	}
	return merged;
}
export function withHermesDashboardAuthEnvironment(
	manifest: RuntimeManifest,
	settings: RuntimeRunSettings | undefined,
): RuntimeRunSettings | undefined {
	const auth = manifest.hermesDashboardAuth;
	if (!auth) return settings;
	if (!auth.activation.enabled) {
		throw new Error("Hermes password authentication is disabled");
	}
	return {
		...(settings ?? {}),
		prependPath: settings?.prependPath ?? [],
		env: settings?.env ?? {},
		secretEnv: {
			...(settings?.secretEnv ?? {}),
			HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: auth.passwordSecretRef,
			HERMES_DASHBOARD_BASIC_AUTH_SECRET: auth.sessionSecretRef,
		},
	};
}
