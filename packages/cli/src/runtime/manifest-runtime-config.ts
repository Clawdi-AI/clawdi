import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import {
	getHermesRawConfigValue,
	type HermesConfigTransaction,
	reconcileHermesConfigValue,
} from "./hermes-config";
import { mergeRuntimeEnvWithProviderPlaceholders } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeName, RuntimeRunSettings, RuntimeServiceName } from "./run-config";

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
type ManagedLocaleConflict = "malformed" | "duplicated";

function managedLocaleMarkerConflict(content: string): ManagedLocaleConflict | null {
	const start = content.indexOf(MANAGED_LOCALE_BLOCK_START);
	const end = content.indexOf(MANAGED_LOCALE_BLOCK_END);
	const hasStart = start !== -1;
	const hasEnd = end !== -1;
	if (hasStart !== hasEnd || (hasStart && end < start)) {
		return "malformed";
	}
	if (
		hasStart &&
		(content.indexOf(MANAGED_LOCALE_BLOCK_START, start + MANAGED_LOCALE_BLOCK_START.length) !==
			-1 ||
			content.indexOf(MANAGED_LOCALE_BLOCK_END, end + MANAGED_LOCALE_BLOCK_END.length) !== -1)
	) {
		return "duplicated";
	}
	return null;
}

function appendManagedLocaleBlock(existing: string, block: string): string {
	const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	return `${existing}${separator}${block}\n`;
}

function repairManagedLocaleFileContent(existing: string, block: string): string {
	const ownedLines = new Set(block.split("\n").filter((line) => line !== ""));
	const keptLines: string[] = [];
	let followsManagedHeading = false;
	// Keep each retained line's original terminator, including mixed line endings.
	for (const line of existing.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []) {
		const content = line.replace(/(?:\r\n|\r|\n)$/, "");
		const headingBlank = followsManagedHeading && content === "";
		followsManagedHeading = content === "## Clawdi managed locale";
		if (headingBlank || ownedLines.has(content) || content.includes("clawdi managed locale")) {
			continue;
		}
		keptLines.push(line);
	}
	return appendManagedLocaleBlock(keptLines.join(""), block);
}

export function nextManagedLocaleFileContent(
	path: string,
	block: string,
):
	| { existing: string; next: string; repaired?: ManagedLocaleConflict }
	| { conflict: ManagedLocaleConflict } {
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const conflict = managedLocaleMarkerConflict(existing);
	if (conflict) {
		const next = repairManagedLocaleFileContent(existing, block);
		if (managedLocaleMarkerConflict(next)) return { conflict };
		return { existing, next, repaired: conflict };
	}
	const start = existing.indexOf(MANAGED_LOCALE_BLOCK_START);
	const end = existing.indexOf(MANAGED_LOCALE_BLOCK_END);
	const next =
		start !== -1 && end !== -1
			? `${existing.slice(0, start)}${block}${existing.slice(end + MANAGED_LOCALE_BLOCK_END.length)}`
			: appendManagedLocaleBlock(existing, block);

	return { existing, next };
}
function updateManagedLocaleFile(
	path: string,
	block: string,
): { file: string | null; conflict: string | null; repaired?: ManagedLocaleConflict } {
	const result = nextManagedLocaleFileContent(path, block);
	if ("conflict" in result) return { file: null, conflict: `${result.conflict}:${path}` };
	if (result.next !== result.existing) {
		writePrivateFileAtomic(path, result.next, { mode: 0o600, dirMode: 0o700 });
	}
	return { file: path, conflict: null, repaired: result.repaired };
}
function applyHermesDashboardConfig(
	context: HermesConfigTransaction,
	auth: NonNullable<RuntimeManifest["hermesDashboardAuth"]>,
): void {
	reconcileHermesConfigValue(context, "dashboard.basic_auth", undefined);
	reconcileHermesConfigValue(context, "dashboard.oauth", {
		self_hosted: {
			issuer: auth.issuer,
			client_id: auth.clientId,
			scopes: "openid profile email",
		},
	});
	reconcileHermesConfigValue(context, "dashboard.public_url", auth.publicUrl);
	reconcileHermesConfigValue(context, "dashboard.trusted_proxies", auth.trustedProxies);
	const currentDisabled = getHermesRawConfigValue(context, "plugins.disabled");
	if (
		currentDisabled.exists &&
		(!Array.isArray(currentDisabled.value) ||
			currentDisabled.value.some((value) => typeof value !== "string"))
	) {
		throw new Error("Hermes config field plugins.disabled must be a string array");
	}
	const disabled = new Set(currentDisabled.exists ? (currentDisabled.value as string[]) : []);
	disabled.add("dashboard_auth/basic");
	disabled.add("dashboard_auth/nous");
	disabled.delete("dashboard_auth/self_hosted");
	reconcileHermesConfigValue(context, "plugins.disabled", [...disabled].sort());
}
export function applyHostedRuntimeConfigProjection(
	runtime: string,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
	workspaceRoot: string,
	hermesConfig: HermesConfigTransaction | null,
): { file: string | null; conflict: string | null; repaired?: ManagedLocaleConflict } {
	if (manifest.runtimes[runtime]?.enabled !== true) return { file: null, conflict: null };
	const locale = manifest.locale;
	if (runtime === "openclaw") {
		if (!openClawWorkspaceRoot) throw new Error("OpenClaw official agent workspace is unavailable");
		return locale
			? updateManagedLocaleFile(join(openClawWorkspaceRoot, "SOUL.md"), managedLocaleBlock(locale))
			: { file: null, conflict: null };
	}
	if (runtime === "hermes") {
		if (!hermesConfig) throw new Error("Hermes config command is unavailable");
		const auth = manifest.hermesDashboardAuth;
		const hermesHome = join(home, ".hermes");
		reconcileHermesConfigValue(hermesConfig, "terminal.cwd", workspaceRoot);
		if (auth) applyHermesDashboardConfig(hermesConfig, auth);
		if (locale) reconcileHermesConfigValue(hermesConfig, "timezone", locale.timezone);
		return locale
			? updateManagedLocaleFile(join(hermesHome, "SOUL.md"), managedLocaleBlock(locale))
			: { file: null, conflict: null };
	}
	return { file: null, conflict: null };
}
export function resolvedRuntimeServiceSettings(
	manifest: RuntimeManifest,
	runtime: RuntimeName,
	service: RuntimeServiceName,
	settings: RuntimeRunSettings,
	providerEnv: Record<string, string>,
): RuntimeRunSettings {
	const merged = mergeRuntimeEnvWithProviderPlaceholders(
		runtime,
		withHermesManagedAiDefaults(manifest, runtime, settings) ?? settings,
		providerEnv,
		service,
	);
	return merged;
}
export function resolvedRuntimeSettings(
	manifest: RuntimeManifest,
	runtime: string,
	settings: RuntimeRunSettings | undefined,
	providerEnv: Record<string, string>,
): RuntimeRunSettings | undefined {
	return mergeRuntimeEnvWithProviderPlaceholders(
		runtime,
		withHermesManagedAiDefaults(manifest, runtime, settings),
		providerEnv,
	);
}

function withHermesManagedAiDefaults(
	manifest: RuntimeManifest,
	runtime: string,
	settings: RuntimeRunSettings | undefined,
): RuntimeRunSettings | undefined {
	const desired = manifest.runtimes[runtime];
	const providerId = desired?.primary_model?.provider_id;
	const provider = providerId ? manifest.projection?.providers?.[providerId] : undefined;
	if (
		runtime !== "hermes" ||
		!desired?.enabled ||
		!providerId ||
		provider?.managed_by !== "clawdi" ||
		provider.status === "error" ||
		provider.apiMode !== "openai_responses" ||
		settings?.secretEnv?.HERMES_API_CALL_STALE_TIMEOUT !== undefined
	)
		return settings;
	return {
		...settings,
		prependPath: settings?.prependPath ?? [],
		// Maximum native Codex context floor, not a dynamic-policy equivalent.
		// Hermes provider/model config and its user .env still take precedence.
		env: { HERMES_API_CALL_STALE_TIMEOUT: "1200", ...settings?.env },
	};
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
