import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AiProvider, AiProviderCatalog } from "@clawdi/shared";
import chalk from "chalk";
import { getCodexHome, getHermesHome, getOpenClawHome } from "../adapters/paths";
import { aiProviderCatalogPath, readAiProviderCatalog } from "../lib/ai-provider-catalog";
import {
	AGENT_TARGET_CONTRACTS,
	type AgentTarget,
	type AgentTargetProjection,
	buildAgentTargetProjection,
	CODEX_PROFILE_NAME,
} from "../lib/ai-provider-projection";
import { ApiClient } from "../lib/api-client";
import {
	decideChatGptOAuthCredentialReconciliation,
	type NativeOAuthCredentialAction,
	type NativeOAuthCredentialObservation,
} from "../lib/chatgpt-oauth-reconciliation";
import {
	HERMES_CODEX_AUTH_HELPER,
	type HermesCodexAuthAction,
	nativeOAuthObservation,
	nativeOAuthProfileId,
	type OAuthCredentialOwnership,
	OPENCLAW_PROVIDER_AUTH_HELPER,
	oauthCredentialFingerprint,
	resolveOpenClawProviderAuthSdkExport,
} from "../lib/codex-oauth-native-store";
import { getClawdiDir } from "../lib/config";
import { mergeHermesConfig } from "../lib/hermes-config-merge";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { getEnvIdByAgent } from "../lib/select-adapter";
import { parseAgentCredentialProfilePayload } from "./agent-credentials";

interface AiProviderApplyOptions {
	source?: string;
	target?: string;
	dryRun?: boolean;
	json?: boolean;
}

interface AiProviderStatusOptions {
	json?: boolean;
}

interface AiProviderApplyWrite {
	path: string;
	mode: string;
	content: string;
}

interface AiProviderApplySecretWrite {
	path: string;
	mode: string;
	description: string;
	source_provider_id: string;
	source_profile: string;
}

interface AiProviderApplyCommandStep {
	command: string;
	args: string[];
	display: string;
	stdin?: string;
}

interface AiProviderApplyMerge {
	path: string;
	mode: string;
	description: string;
	patch: string;
}

interface AiProviderApplyPlan {
	source: string;
	target: AgentTarget;
	target_contract: AgentTargetProjection["contract"];
	provider_ids: string[];
	default_provider_id: string;
	writes: AiProviderApplyWrite[];
	secret_writes: AiProviderApplySecretWrite[];
	merges: AiProviderApplyMerge[];
	commands: AiProviderApplyCommandStep[];
	next_steps: string[];
	warnings: string[];
}

interface PreparedAiProviderApplyPlan {
	plan: AiProviderApplyPlan;
	secrets: PreparedAiProviderSecretMaterial[];
}

interface PreparedAiProviderSecretMaterial {
	target: AgentTarget;
	providerId: string;
	profile: string;
	credentialRevision: string;
	path: string;
	material: CodexAuthMaterial;
}

interface ResolvedCodexAuthMaterial {
	credentialRevision: string;
	material: CodexAuthMaterial;
}

type AiProviderApplyPlanBody = Omit<AiProviderApplyPlan, "source">;

interface AiProviderApplySkippedTarget {
	target: AgentTarget;
	reason: string;
}

interface CodexAgentProfileSource {
	provider_id: string;
	profile: string;
}

interface AiProviderAuthResolveBackendResponse {
	provider_id?: string;
	auth_type?: string;
	payload?: string;
	profile?: string;
	tool?: string;
	credential_revision?: string;
}

interface CodexAuthMaterial {
	rawContent: string;
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	accountId?: string;
	lastRefresh: string;
	expires: number;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_APPLY_TARGETS = ["codex", "hermes", "openclaw"] as const;
const CODEX_AUTH_LOGICAL_NAME = "auth.json";
const OPENCLAW_OPENAI_AUTH_PROFILE_PROVIDER = "openai";

export async function aiProviderApplyCommand(opts: AiProviderApplyOptions = {}): Promise<void> {
	const targets = parseApplyTargets(opts.target);
	const multiTarget = targets.length > 1;
	const selection = selectApplySource(
		readAiProviderCatalog({ allowNoAuthPublic: true }),
		opts.source,
	);
	if (
		targets.length !== 1 &&
		selection.catalog.providers.some(
			(provider) => provider.auth.type === "agent_profile" && provider.auth.tool === "codex",
		)
	) {
		throw new Error(
			"Codex OAuth credentials have a single runtime owner; choose exactly one --target.",
		);
	}
	const plans: AiProviderApplyPlan[] = [];
	const skipped: AiProviderApplySkippedTarget[] = [];
	for (const target of targets) {
		try {
			const projection = buildAgentTargetProjection(target, selection.catalog);
			plans.push({
				source: selection.source,
				...buildAiProviderApplyPlan(target, projection, selection.catalog),
			});
		} catch (error) {
			if (!multiTarget) throw error;
			skipped.push({ target, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	if (plans.length === 0) {
		throw new Error(
			`No AI Provider targets can be applied:\n${skipped.map((entry) => `- ${entry.target}: ${entry.reason}`).join("\n")}`,
		);
	}
	if (!opts.dryRun) {
		// Resolve and validate every credential before the first target mutates local config.
		const preparedPlans = await prepareAiProviderApplyPlans(plans, selection.catalog);
		for (const prepared of preparedPlans) applyAiProviderPlan(prepared.plan, prepared.secrets);
	}
	printAiProviderApplyResult(plans, skipped, Boolean(opts.dryRun), Boolean(opts.json), multiTarget);
}

export async function aiProviderStatusCommand(opts: AiProviderStatusOptions = {}): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const rows = catalog.providers.map((provider) => ({
		id: provider.id,
		type: provider.type,
		models: modelsSummary(provider),
		auth: describeAuth(provider),
		agent_env_name: inferredAgentEnvName(provider) ?? provider.runtime_env_name ?? null,
	}));
	const agents = (["openclaw", "hermes", "codex"] as const).map((target) =>
		inspectAiProviderAgentApply(target),
	);
	const result = {
		catalog_path: aiProviderCatalogPath(),
		provider_count: catalog.providers.length,
		defaults: catalog.defaults ?? {},
		providers: rows,
		agents,
	};
	if (opts.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(chalk.bold("AI Provider agents"));
	console.log(`Providers: ${rows.length}`);
	for (const row of rows) {
		console.log(
			`  ${row.id} (${row.type}) models=${row.models} auth=${row.auth} env=${row.agent_env_name ?? "-"}`,
		);
	}
	for (const agent of agents) {
		const state =
			agent.applied === true
				? chalk.green("applied")
				: agent.applied === false
					? chalk.gray("not applied")
					: chalk.gray(agent.apply_status);
		console.log(`  ${agent.target}: ${state} ${chalk.gray(agent.apply_target)}`);
	}
}

export async function doctorAiProviderCommand(opts: { json?: boolean } = {}): Promise<void> {
	const checks = [];
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	checks.push({
		name: "AI Provider catalog",
		ok: catalog.providers.length > 0,
		detail: `${catalog.providers.length} provider(s)`,
	});
	for (const target of ["openclaw", "hermes", "codex"] as const) {
		try {
			const projection = buildAgentTargetProjection(target, catalog);
			checks.push({
				name: `Agent config: ${target}`,
				ok: true,
				detail: projection.warnings.length > 0 ? projection.warnings.join("; ") : undefined,
			});
		} catch (error) {
			checks.push({
				name: `Agent config: ${target}`,
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (opts.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}
	for (const check of checks) {
		const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
		const detail = check.detail ? chalk.gray(` — ${check.detail}`) : "";
		console.log(`  ${icon} ${check.name}${detail}`);
	}
	if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function parseApplyTargets(input: string | undefined): AgentTarget[] {
	if (!input || input === "all") return [...DEFAULT_APPLY_TARGETS];
	if (input === "openclaw" || input === "hermes" || input === "codex") return [input];
	throw new Error("--target must be all, codex, hermes, or openclaw.");
}

function selectApplySource(
	catalog: ReturnType<typeof readAiProviderCatalog>,
	input: string | undefined,
): { source: string; catalog: ReturnType<typeof readAiProviderCatalog> } {
	if (!input || input === "all") return { source: "all", catalog };
	const providerId =
		input === "default" ? (catalog.defaults?.chat_provider_id ?? catalog.providers[0]?.id) : input;
	if (!providerId) throw new Error("No AI Provider source is configured.");
	const provider = catalog.providers.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`AI Provider source not found: ${providerId}`);
	return {
		source: input === "default" ? "default" : provider.id,
		catalog: {
			...catalog,
			providers: [provider],
			defaults: { ...catalog.defaults, chat_provider_id: provider.id },
		},
	};
}

function buildAiProviderApplyPlan(
	target: AgentTarget,
	projection: AgentTargetProjection,
	catalog: AiProviderCatalog,
): AiProviderApplyPlanBody {
	if (target === "openclaw") return buildOpenClawApplyPlan(projection, catalog);
	if (target === "codex") return buildCodexApplyPlan(projection, catalog);
	const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
	if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
	const configPath = join(getHermesHome(), "config.yaml");
	const secretWrites = buildTargetSecretWrites("hermes", projection, catalog);
	return {
		target,
		target_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [],
		secret_writes: secretWrites,
		merges: [
			{
				path: configPath,
				mode: "0600",
				description: "Hermes config.yaml provider merge",
				patch: file.content,
			},
		],
		commands: [],
		next_steps: [],
		warnings: projection.warnings,
	};
}

function buildOpenClawApplyPlan(
	projection: AgentTargetProjection,
	catalog: AiProviderCatalog,
): AiProviderApplyPlanBody {
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
	const patch = preserveExistingOpenClawProviderModels(file.content);
	return {
		target: "openclaw",
		target_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [],
		secret_writes: buildTargetSecretWrites("openclaw", projection, catalog),
		merges: [],
		commands: [
			{
				command: "openclaw",
				args: ["config", "patch", "--stdin"],
				display: "openclaw config patch --stdin",
				stdin: patch,
			},
		],
		next_steps: [],
		warnings: projection.warnings,
	};
}

function preserveExistingOpenClawProviderModels(patchContent: string): string {
	const patch = parseJsonText(patchContent, "OpenClaw AI Provider patch");
	const patchModels = isPlainRecord(patch.models) ? patch.models : undefined;
	const patchProviders = isPlainRecord(patchModels?.providers) ? patchModels.providers : undefined;
	if (!patchProviders) return patchContent;

	const existing = readOpenClawConfig();
	const existingModels = isPlainRecord(existing.models) ? existing.models : undefined;
	const existingProviders = isPlainRecord(existingModels?.providers)
		? existingModels.providers
		: undefined;
	if (!existingProviders) return patchContent;

	let changed = false;
	for (const [providerId, providerPatch] of Object.entries(patchProviders)) {
		if (!isPlainRecord(providerPatch) || !Array.isArray(providerPatch.models)) continue;
		const providerModels = providerPatch.models;
		const existingProvider = existingProviders[providerId];
		if (!isPlainRecord(existingProvider) || !Array.isArray(existingProvider.models)) continue;

		const existingModelsById = new Map(
			existingProvider.models
				.filter(isPlainRecord)
				.map((model) => [openClawModelEntryId(model), model])
				.filter((entry): entry is [string, Record<string, unknown>] => isNonEmptyString(entry[0])),
		);
		const nextModels = providerModels.map((model) => {
			const modelId = openClawModelEntryId(model);
			const existingModel = modelId ? existingModelsById.get(modelId) : undefined;
			return isPlainRecord(model) && existingModel ? { ...existingModel, ...model } : model;
		});
		const seen = new Set(nextModels.map(openClawModelEntryId).filter(isNonEmptyString));
		let providerChanged = false;
		for (const existingModel of existingProvider.models) {
			const modelId = openClawModelEntryId(existingModel);
			if (!modelId || seen.has(modelId)) continue;
			nextModels.push(existingModel);
			seen.add(modelId);
			providerChanged = true;
		}
		if (providerChanged || nextModels.some((model, index) => model !== providerModels[index])) {
			providerPatch.models = nextModels;
			changed = true;
		}
	}

	return changed ? stringifyJson(patch) : patchContent;
}

function openClawModelEntryId(input: unknown): string | undefined {
	if (!isPlainRecord(input)) return undefined;
	return typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
}

function isNonEmptyString(input: unknown): input is string {
	return typeof input === "string" && input.length > 0;
}

function buildCodexApplyPlan(
	projection: AgentTargetProjection,
	catalog: AiProviderCatalog,
): AiProviderApplyPlanBody {
	const file = projection.files.find((entry) => entry.path.endsWith(".codex.toml"));
	if (!file) throw new Error("Codex projection did not include a profile TOML file.");
	const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
	return {
		target: "codex",
		target_contract: projection.contract,
		provider_ids: projection.provider_ids,
		default_provider_id: projection.default_provider_id,
		writes: [{ path: profilePath, mode: "0600", content: file.content }],
		secret_writes: buildTargetSecretWrites("codex", projection, catalog),
		merges: [],
		commands: [],
		next_steps: [`codex --profile ${CODEX_PROFILE_NAME}`],
		warnings: projection.warnings,
	};
}

function buildTargetSecretWrites(
	target: AgentTarget,
	projection: AgentTargetProjection,
	catalog: AiProviderCatalog,
): AiProviderApplySecretWrite[] {
	const source = selectSingleCodexAuthSource(projection, catalog);
	if (!source) return [];
	const description =
		target === "codex"
			? "Codex auth.json from agent:codex profile"
			: target === "hermes"
				? "Hermes openai-codex auth store"
				: "OpenClaw OpenAI auth profile";
	return [
		{
			path: targetAuthPath(target),
			mode: "0600",
			description,
			source_provider_id: source.provider_id,
			source_profile: source.profile,
		},
	];
}

function selectSingleCodexAuthSource(
	projection: AgentTargetProjection,
	catalog: AiProviderCatalog,
): CodexAgentProfileSource | null {
	const applicableProviders = catalog.providers.filter((provider) =>
		projection.provider_ids.includes(provider.id),
	);
	const sources = applicableProviders
		.filter(
			(
				provider,
			): provider is AiProvider & {
				auth: { type: "agent_profile"; tool: string; profile: string };
			} => provider.auth.type === "agent_profile" && provider.auth.tool === "codex",
		)
		.map((provider) => ({ provider_id: provider.id, profile: provider.auth.profile }));
	if (sources.length === 0) return null;
	const profiles = [...new Set(sources.map((source) => source.profile))];
	if (profiles.length > 1) {
		throw new Error(
			`Cannot apply multiple Codex auth profiles to ${projection.target}: ${profiles.join(", ")}. Apply one source at a time with \`clawdi ai-provider apply <source> --target ${projection.target}\`.`,
		);
	}
	return sources[0] ?? null;
}

function targetAuthPath(target: AgentTarget): string {
	if (target === "codex") return join(getCodexHome(), "auth.json");
	if (target === "hermes") return join(getHermesHome(), "auth.json");
	return join(resolveOpenClawDefaultAgentDir(), "openclaw-agent.sqlite");
}

function modelsSummary(provider: AiProvider): string {
	const models = provider.models?.map((model) => model.id).filter(Boolean) ?? [];
	if (models.length === 0) return "-";
	if (models.length <= 2) return models.join(", ");
	return `${models.slice(0, 2).join(", ")} +${models.length - 2}`;
}

function resolveOpenClawDefaultAgentDir(): string {
	const config = readOpenClawConfig();
	const envAgentId = process.env.OPENCLAW_AGENT_ID?.trim();
	if (envAgentId)
		return join(getOpenClawHome(), "agents", normalizeOpenClawAgentId(envAgentId), "agent");
	const configuredAgent = resolveOpenClawConfiguredDefaultAgent(config);
	if (configuredAgent?.agentDir) return expandHome(configuredAgent.agentDir);
	const agentId = configuredAgent?.id ?? "main";
	return join(getOpenClawHome(), "agents", normalizeOpenClawAgentId(agentId), "agent");
}

function readOpenClawConfig(): JsonRecord {
	for (const filename of ["openclaw.json", "clawdbot.json"]) {
		const path = join(getOpenClawHome(), filename);
		if (!existsSync(path)) continue;
		const parsed = readJsonFile(path);
		return parsed;
	}
	return {};
}

function resolveOpenClawConfiguredDefaultAgent(
	config: JsonRecord,
): { id?: string; agentDir?: string } | null {
	const agents = isPlainRecord(config.agents) ? config.agents : undefined;
	const list = Array.isArray(agents?.list) ? agents.list : [];
	const entries = list.filter(isPlainRecord);
	if (entries.length === 0) return null;
	const selected = entries.find((entry) => entry.default === true) ?? entries[0];
	const id = typeof selected.id === "string" && selected.id.trim() ? selected.id.trim() : "main";
	const agentDir =
		typeof selected.agentDir === "string" && selected.agentDir.trim()
			? selected.agentDir.trim()
			: undefined;
	return { id, agentDir };
}

function normalizeOpenClawAgentId(input: string): string {
	return (
		input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_.-]+/g, "-") || "main"
	);
}

function expandHome(input: string): string {
	if (input === "~") return process.env.HOME ?? input;
	if (input.startsWith("~/")) return join(process.env.HOME ?? "~", input.slice(2));
	return input;
}

async function prepareAiProviderApplyPlans(
	plans: AiProviderApplyPlan[],
	catalog: AiProviderCatalog,
): Promise<PreparedAiProviderApplyPlan[]> {
	const materialCache = new Map<string, Promise<ResolvedCodexAuthMaterial>>();
	return Promise.all(
		plans.map(async (plan) => ({
			plan,
			secrets: await Promise.all(
				plan.secret_writes.map((secretWrite) =>
					prepareAiProviderSecretMaterial(plan.target, secretWrite, catalog, materialCache),
				),
			),
		})),
	);
}

function applyAiProviderPlan(
	plan: AiProviderApplyPlan,
	preparedSecrets: PreparedAiProviderSecretMaterial[],
): void {
	for (const write of plan.writes) {
		writeAiProviderFile(write.path, write.content);
	}
	for (const merge of plan.merges) {
		mergeHermesConfig(merge.path, merge.patch);
	}
	for (const command of plan.commands) {
		runAiProviderApplyCommand(command);
	}
	if (preparedSecrets.length === 0) {
		cleanupStaleLocalOAuthReceipts(plan.target, new Set());
	}
	for (const prepared of preparedSecrets) {
		cleanupStaleLocalOAuthReceipts(prepared.target, new Set([prepared.providerId]));
		reconcileLocalOAuthCredential({
			target: prepared.target,
			providerId: prepared.providerId,
			profile: prepared.profile,
			credentialRevision: prepared.credentialRevision,
			path: prepared.path,
			material: prepared.material,
		});
	}
}

async function prepareAiProviderSecretMaterial(
	target: AgentTarget,
	secretWrite: AiProviderApplySecretWrite,
	catalog: AiProviderCatalog,
	materialCache: Map<string, Promise<ResolvedCodexAuthMaterial>>,
): Promise<PreparedAiProviderSecretMaterial> {
	const source = catalog.providers.find(
		(provider) => provider.id === secretWrite.source_provider_id,
	);
	if (source?.auth.type !== "agent_profile" || source.auth.tool !== "codex") {
		throw new Error(
			`AI Provider ${secretWrite.source_provider_id} is not a Codex auth profile source.`,
		);
	}
	if (source.auth.profile !== secretWrite.source_profile) {
		throw new Error(`AI Provider ${source.id} auth profile changed while preparing apply.`);
	}
	const sourceProfile = source.auth.profile;
	const environmentId = getEnvIdByAgent(target);
	if (!environmentId) {
		throw new Error(`${target} must be registered before applying provider OAuth auth.`);
	}
	const cacheKey = `${source.id}\u0000${sourceProfile}\u0000${environmentId}\u0000${target}`;
	let materialPromise = materialCache.get(cacheKey);
	if (!materialPromise) {
		materialPromise = resolveProviderAuthPayload(
			source.id,
			sourceProfile,
			environmentId,
			target,
		).then((resolved) => ({
			credentialRevision: resolved.credentialRevision,
			material: parseCodexAuthMaterial(sourceProfile, resolved.payload),
		}));
		materialCache.set(cacheKey, materialPromise);
	}
	const resolved = await materialPromise;
	return {
		target,
		providerId: source.id,
		profile: sourceProfile,
		credentialRevision: resolved.credentialRevision,
		path: secretWrite.path,
		material: resolved.material,
	};
}

async function resolveProviderAuthPayload(
	providerId: string,
	profile: string,
	environmentId: string,
	consumerRuntime: AgentTarget,
): Promise<{ payload: string; credentialRevision: string }> {
	const response = await new ApiClient().postJsonBody<AiProviderAuthResolveBackendResponse>(
		`/v1/ai-providers/${encodeURIComponent(providerId)}/auth/resolve`,
		{ profile, environment_id: environmentId, consumer_runtime: consumerRuntime },
	);
	if (!response.payload) {
		throw new Error(`AI Provider ${providerId} auth resolve returned no credential payload.`);
	}
	if (!response.credential_revision) {
		throw new Error(`AI Provider ${providerId} auth resolve returned no credential revision.`);
	}
	return { payload: response.payload, credentialRevision: response.credential_revision };
}

interface LocalOAuthReceipt {
	schemaVersion: "clawdi.runtimeOAuthCredential.v1";
	runtime: AgentTarget;
	providerId: string;
	nativeProfileId: string;
	credentialRevision: string;
	state: "seeded" | "adopted" | "revoked";
	credentialFingerprint?: string;
}

function localOAuthReceiptPath(target: AgentTarget, providerId: string): string {
	const providerKey = createHash("sha256").update(providerId).digest("hex");
	return join(getClawdiDir(), "oauth-credentials", target, `${providerKey}.json`);
}

function readLocalOAuthReceipt(path: string): LocalOAuthReceipt | null {
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LocalOAuthReceipt>;
	if (
		parsed.schemaVersion !== "clawdi.runtimeOAuthCredential.v1" ||
		!parsed.runtime ||
		!(["codex", "hermes", "openclaw"] as const).includes(parsed.runtime) ||
		typeof parsed.providerId !== "string" ||
		typeof parsed.nativeProfileId !== "string" ||
		typeof parsed.credentialRevision !== "string" ||
		!parsed.state ||
		!(["seeded", "adopted", "revoked"] as const).includes(parsed.state) ||
		(parsed.credentialFingerprint !== undefined &&
			!/^sha256:[a-f0-9]{64}$/.test(parsed.credentialFingerprint))
	) {
		throw new Error(`Invalid local OAuth credential receipt: ${path}`);
	}
	return parsed as LocalOAuthReceipt;
}

function writeLocalOAuthReceipt(path: string, receipt: LocalOAuthReceipt): void {
	writeAiProviderFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

function runLocalHermesCodexAuthCommand(
	path: string,
	action: HermesCodexAuthAction,
	profileId: string,
	material?: CodexAuthMaterial,
	ownership?: OAuthCredentialOwnership,
): JsonRecord {
	const nodeArgs = [
		"--input-type=module",
		"--eval",
		HERMES_CODEX_AUTH_HELPER,
		path,
		action,
		profileId,
		ownership?.nativeProfileId ?? "",
	];
	const command = process.platform === "win32" ? "node" : "flock";
	const args =
		process.platform === "win32"
			? nodeArgs
			: ["--timeout", "10", join(dirname(path), "auth.lock"), "node", ...nodeArgs];
	const output = execFileSync(command, args, {
		encoding: "utf8",
		input: JSON.stringify(material ?? null),
		stdio: ["pipe", "pipe", "pipe"],
	});
	return readJsonText(output, `Hermes Codex auth ${action}`);
}

function observeLocalHermesCodexAuth(
	path: string,
	profileId: string,
	ownership?: OAuthCredentialOwnership,
): NativeOAuthCredentialObservation {
	return nativeOAuthObservation(
		runLocalHermesCodexAuthCommand(path, "inspect", profileId, undefined, ownership).observation,
	);
}

function runLocalHermesCodexAuth(
	path: string,
	action: Exclude<HermesCodexAuthAction, "inspect">,
	profileId: string,
	material?: CodexAuthMaterial,
	ownership?: OAuthCredentialOwnership,
): boolean {
	return (
		runLocalHermesCodexAuthCommand(path, action, profileId, material, ownership).updated === true
	);
}

function localOpenClawProviderAuthSdkPath(): string {
	const override = process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK?.trim();
	if (override) return override;
	let commandPath: string | null = null;
	try {
		commandPath = execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim();
	} catch {
		// Candidate paths below still cover official local installations.
	}
	const sdkPath = resolveOpenClawProviderAuthSdkExport([
		commandPath,
		join(getOpenClawHome(), "lib", "node_modules", "openclaw"),
		join(getOpenClawHome(), "node_modules", "openclaw"),
	]);
	if (!sdkPath) {
		throw new Error(
			"Installed OpenClaw lacks the public provider-auth SDK. Upgrade or repair OpenClaw with its official unversioned installer, then rerun this command; local apply will not install software automatically.",
		);
	}
	return sdkPath;
}

function localOpenClawCredentialObservation(
	agentDir: string,
	profileId: string,
	ownership?: OAuthCredentialOwnership,
): NativeOAuthCredentialObservation {
	const output = execFileSync(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_PROVIDER_AUTH_HELPER,
			localOpenClawProviderAuthSdkPath(),
			agentDir,
			"inspect",
			profileId,
			ownership?.nativeProfileId ?? "",
		],
		{ encoding: "utf8", input: "null", stdio: ["pipe", "pipe", "pipe"] },
	);
	return nativeOAuthObservation(readJsonText(output, "OpenClaw provider-auth inspect").observation);
}

function writeLocalOpenClawCredential(
	agentDir: string,
	profileId: string,
	material: CodexAuthMaterial,
	action: "seed-if-missing" | "upsert",
): void {
	const credential = JSON.stringify(
		compactObject({
			type: "oauth",
			provider: OPENCLAW_OPENAI_AUTH_PROFILE_PROVIDER,
			access: material.accessToken,
			refresh: material.refreshToken,
			expires: material.expires,
			accountId: material.accountId,
			idToken: material.idToken,
			copyToAgents: false,
		}),
	);
	execFileSync(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_PROVIDER_AUTH_HELPER,
			localOpenClawProviderAuthSdkPath(),
			agentDir,
			action,
			profileId,
		],
		{ input: credential, stdio: "pipe" },
	);
}

function removeLocalOpenClawCredential(
	agentDir: string,
	profileId: string,
	ownership: OAuthCredentialOwnership,
): void {
	execFileSync(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_PROVIDER_AUTH_HELPER,
			localOpenClawProviderAuthSdkPath(),
			agentDir,
			"remove",
			profileId,
			ownership.nativeProfileId,
		],
		{ input: "null", stdio: "pipe" },
	);
}

function cleanupStaleLocalOAuthReceipts(
	target: AgentTarget,
	desiredProviderIds: ReadonlySet<string>,
): void {
	const receiptDir = join(getClawdiDir(), "oauth-credentials", target);
	if (!existsSync(receiptDir)) return;
	for (const filename of readdirSync(receiptDir).filter((name) => name.endsWith(".json"))) {
		const path = join(receiptDir, filename);
		const receipt = readLocalOAuthReceipt(path);
		if (!receipt || desiredProviderIds.has(receipt.providerId)) continue;
		const ownership = localOAuthReceiptOwnership(receipt);
		const native = observeLocalOAuthCredential(
			target,
			targetAuthPath(target),
			receipt.nativeProfileId,
			ownership,
		);
		const decision = decideChatGptOAuthCredentialReconciliation({
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			receipt,
			native,
		});
		if (decision.nativeAction === "remove" && ownership) {
			removeLocalOAuthCredential(
				target,
				targetAuthPath(target),
				receipt.nativeProfileId,
				ownership,
			);
		}
		rmSync(path, { force: true });
	}
}

function readJsonText(content: string, label: string): JsonRecord {
	return parseJsonText(content, label);
}

function reconcileLocalOAuthCredential(input: {
	target: AgentTarget;
	providerId: string;
	profile: string;
	credentialRevision: string;
	path: string;
	material: CodexAuthMaterial;
}): void {
	const receiptPath = localOAuthReceiptPath(input.target, input.providerId);
	const receipt = readLocalOAuthReceipt(receiptPath);
	const nativeProfileId = nativeOAuthProfileId(input.target, input.providerId);
	const native = observeLocalOAuthCredential(
		input.target,
		input.path,
		nativeProfileId,
		localOAuthReceiptOwnership(receipt),
	);
	const decision = decideChatGptOAuthCredentialReconciliation({
		desiredCredentialRevision: input.credentialRevision,
		desiredNativeProfileId: nativeProfileId,
		receipt,
		native,
	});
	executeLocalOAuthCredentialAction(decision.nativeAction, input, nativeProfileId);
	if (!decision.nextReceipt) {
		throw new Error("Desired OAuth credential reconciliation did not produce a receipt");
	}
	const credentialFingerprint =
		input.target === "codex" && decision.nextReceipt.state === "seeded"
			? decision.nativeAction === "seed" || decision.nativeAction === "upsert"
				? oauthCredentialFingerprint(
						input.credentialRevision,
						input.material.accessToken,
						input.material.refreshToken,
					)
				: receipt?.credentialFingerprint
			: undefined;
	writeLocalOAuthReceipt(receiptPath, {
		schemaVersion: "clawdi.runtimeOAuthCredential.v1",
		runtime: input.target,
		providerId: input.providerId,
		...decision.nextReceipt,
		...(credentialFingerprint ? { credentialFingerprint } : {}),
	});
}

function localOAuthReceiptOwnership(
	receipt: LocalOAuthReceipt | null,
): OAuthCredentialOwnership | undefined {
	if (receipt?.state !== "seeded") return undefined;
	if (receipt.runtime === "codex" && !receipt.credentialFingerprint) return undefined;
	return {
		nativeProfileId: receipt.nativeProfileId,
		...(receipt.credentialFingerprint
			? {
					credentialRevision: receipt.credentialRevision,
					credentialFingerprint: receipt.credentialFingerprint,
				}
			: {}),
	};
}

function localCodexCredentialObservation(
	authPath: string,
	ownership?: OAuthCredentialOwnership,
): NativeOAuthCredentialObservation {
	if (existsSync(authPath)) {
		try {
			const auth = parseJsonText(readFileSync(authPath, "utf8"), "Codex auth.json");
			const tokens = isPlainRecord(auth.tokens) ? auth.tokens : undefined;
			const accessToken = readOptionalString(tokens?.access_token);
			const refreshToken = readOptionalString(tokens?.refresh_token);
			if (
				ownership &&
				accessToken &&
				refreshToken &&
				ownership.credentialRevision &&
				ownership.credentialFingerprint &&
				oauthCredentialFingerprint(ownership.credentialRevision, accessToken, refreshToken) ===
					ownership.credentialFingerprint
			) {
				return "managed";
			}
		} catch {
			// An unreadable native credential is foreign and must not be replaced or removed.
		}
		return "foreign";
	}
	return spawnSync("codex", ["login", "status"], { env: process.env, stdio: "ignore" }).status === 0
		? "foreign"
		: "missing";
}

function observeLocalOAuthCredential(
	target: AgentTarget,
	authPath: string,
	nativeProfileId: string,
	ownership?: OAuthCredentialOwnership,
): NativeOAuthCredentialObservation {
	if (target === "codex") return localCodexCredentialObservation(authPath, ownership);
	if (target === "hermes") return observeLocalHermesCodexAuth(authPath, nativeProfileId, ownership);
	return localOpenClawCredentialObservation(
		resolveOpenClawDefaultAgentDir(),
		nativeProfileId,
		ownership,
	);
}

function executeLocalOAuthCredentialAction(
	action: NativeOAuthCredentialAction,
	input: {
		target: AgentTarget;
		path: string;
		material: CodexAuthMaterial;
	},
	nativeProfileId: string,
): void {
	if (action === "preserve") return;
	if (action === "remove") {
		throw new Error("Desired OAuth credential reconciliation cannot remove a credential");
	}
	seedLocalOAuthCredential(
		input,
		nativeProfileId,
		action === "seed" ? "seed-if-missing" : "upsert",
	);
}

function removeLocalOAuthCredential(
	target: AgentTarget,
	authPath: string,
	nativeProfileId: string,
	ownership: OAuthCredentialOwnership,
): void {
	if (target === "codex") {
		if (localCodexCredentialObservation(authPath, ownership) === "managed") {
			rmSync(authPath, { force: true });
		}
		return;
	}
	if (target === "hermes") {
		runLocalHermesCodexAuth(authPath, "remove", nativeProfileId, undefined, ownership);
		return;
	}
	removeLocalOpenClawCredential(resolveOpenClawDefaultAgentDir(), nativeProfileId, ownership);
}

function seedLocalOAuthCredential(
	input: {
		target: AgentTarget;
		path: string;
		material: CodexAuthMaterial;
	},
	nativeProfileId: string,
	action: "seed-if-missing" | "upsert",
): void {
	if (input.target === "codex") {
		writeAiProviderFile(input.path, input.material.rawContent);
		return;
	}
	if (input.target === "hermes") {
		runLocalHermesCodexAuth(input.path, action, nativeProfileId, input.material);
		return;
	}
	writeLocalOpenClawCredential(
		resolveOpenClawDefaultAgentDir(),
		nativeProfileId,
		input.material,
		action,
	);
}

function parseCodexAuthMaterial(profile: string, payload: string): CodexAuthMaterial {
	const envelope = parseAgentCredentialProfilePayload("codex", profile, payload);
	const file = envelope.files.find((entry) => entry.logicalName === CODEX_AUTH_LOGICAL_NAME);
	if (!file) throw new Error("Stored Codex credential profile is missing auth.json.");
	const authJson = parseJsonText(file.content, "Stored Codex auth.json");
	const tokens = isPlainRecord(authJson.tokens) ? authJson.tokens : undefined;
	if (!tokens) throw new Error("Stored Codex auth.json is missing tokens.");
	const accessToken = readRequiredString(tokens.access_token, "Codex access_token");
	const refreshToken = readRequiredString(tokens.refresh_token, "Codex refresh_token");
	const idToken = readOptionalString(tokens.id_token);
	const accountId =
		readOptionalString(tokens.account_id) ?? decodeJwtStringClaim(accessToken, "sub");
	const lastRefresh =
		readOptionalString(authJson.last_refresh) ?? new Date().toISOString().replace("+00:00", "Z");
	return {
		rawContent: file.content,
		accessToken,
		refreshToken,
		idToken,
		accountId,
		lastRefresh,
		expires: decodeJwtExpiryMs(accessToken) ?? Date.now() + 60 * 60 * 1000,
	};
}

function printAiProviderApplyPlan(plan: AiProviderApplyPlan, dryRun: boolean, json: boolean): void {
	if (json) {
		console.log(JSON.stringify({ ...plan, dry_run: dryRun }, null, 2));
		return;
	}
	for (const warning of plan.warnings) console.log(chalk.yellow(`! ${warning}`));
	const prefix = dryRun ? "Would" : "Applied";
	for (const write of plan.writes) {
		console.log(`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} write ${write.path}`);
	}
	for (const write of plan.secret_writes) {
		console.log(
			`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} write ${write.description} at ${write.path}`,
		);
	}
	for (const merge of plan.merges) {
		console.log(
			`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} merge ${merge.description} at ${merge.path}`,
		);
		if (dryRun) console.log(merge.patch.trimEnd());
	}
	for (const command of plan.commands) {
		console.log(`${dryRun ? chalk.gray("•") : chalk.green("✓")} ${prefix} run ${command.display}`);
		if (dryRun && command.stdin) console.log(command.stdin.trimEnd());
	}
	for (const next of plan.next_steps) {
		console.log(chalk.gray(`Next: ${next}`));
	}
}

function printAiProviderApplyResult(
	plans: AiProviderApplyPlan[],
	skipped: AiProviderApplySkippedTarget[],
	dryRun: boolean,
	json: boolean,
	multiTarget: boolean,
): void {
	if (!multiTarget && plans.length === 1 && skipped.length === 0) {
		printAiProviderApplyPlan(plans[0], dryRun, json);
		return;
	}
	if (json) {
		console.log(
			JSON.stringify(
				{
					dry_run: dryRun,
					targets: plans.map((plan) => ({ ...plan, dry_run: dryRun })),
					skipped,
				},
				null,
				2,
			),
		);
		return;
	}
	for (const plan of plans) {
		console.log(chalk.bold(`AI Provider apply target: ${plan.target}`));
		printAiProviderApplyPlan(plan, dryRun, false);
	}
	for (const entry of skipped) {
		console.log(chalk.yellow(`! Skipped ${entry.target}: ${entry.reason}`));
	}
}

function readJsonFile(path: string): JsonRecord {
	return parseJsonText(readFileSync(path, "utf-8"), path);
}

function parseJsonText(content: string, label: string): JsonRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainRecord(parsed)) throw new Error(`${label} must be a JSON object.`);
	return parsed;
}

function stringifyJson(input: JsonRecord): string {
	return `${JSON.stringify(input, null, 2)}\n`;
}

function readRequiredString(input: unknown, label: string): string {
	if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is missing.`);
	return input;
}

function readOptionalString(input: unknown): string | undefined {
	return typeof input === "string" && input.trim() ? input : undefined;
}

function compactObject(input: JsonRecord): JsonRecord {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function decodeJwtExpiryMs(token: string): number | undefined {
	const exp = decodeJwtNumberClaim(token, "exp");
	return exp === undefined ? undefined : exp * 1000;
}

function decodeJwtNumberClaim(token: string, claim: string): number | undefined {
	const payload = decodeJwtPayload(token);
	const value = payload?.[claim];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function decodeJwtStringClaim(token: string, claim: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const value = payload?.[claim];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function decodeJwtPayload(token: string): JsonRecord | undefined {
	const [, payload] = token.split(".");
	if (!payload) return undefined;
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
		return isPlainRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function writeAiProviderFile(path: string, content: string): void {
	writePrivateFileAtomic(path, content, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

function runAiProviderApplyCommand(command: AiProviderApplyCommandStep): void {
	try {
		execFileSync(command.command, command.args, {
			input: command.stdin,
			stdio: "pipe",
			env: process.env,
		});
	} catch (error) {
		throw new Error(
			`Failed to run ${command.display}${formatCommandStatus(error)}. Re-run with --dry-run to inspect the generated patch and verify the agent CLI is installed.`,
		);
	}
}

function formatCommandStatus(error: unknown): string {
	if (typeof error !== "object" || error === null || !("status" in error)) return "";
	const status = (error as { status?: unknown }).status;
	if (typeof status !== "number") return "";
	return ` (exit ${status})`;
}

function describeAuth(provider: { auth: { type: string }; runtime_env_name?: string }): string {
	const env = inferredAgentEnvName(provider);
	if (provider.auth.type === "none") return "none";
	if (env) return `${provider.auth.type}:env:${env}`;
	return provider.auth.type;
}

function inferredAgentEnvName(provider: {
	auth:
		| { type: string; ref?: string; source?: string }
		| { type: string; provider?: string; profile?: string }
		| { type: string; tool?: string; profile?: string };
	runtime_env_name?: string;
}): string | undefined {
	const auth = provider.auth;
	if ("ref" in auth && auth.ref?.startsWith("env:")) return auth.ref.slice("env:".length);
	return provider.runtime_env_name;
}

function inspectAiProviderAgentApply(target: AgentTarget): {
	target: AgentTarget;
	target_contract: (typeof AGENT_TARGET_CONTRACTS)[AgentTarget];
	apply_target: string;
	apply_status: string;
	applied: boolean | null;
} {
	if (target === "codex") {
		const profilePath = join(getCodexHome(), `${CODEX_PROFILE_NAME}.config.toml`);
		const applied = existsSync(profilePath);
		return {
			target,
			target_contract: AGENT_TARGET_CONTRACTS[target],
			apply_target: profilePath,
			apply_status: applied ? "applied" : "not applied",
			applied,
		};
	}
	if (target === "hermes") {
		const configPath = join(getHermesHome(), "config.yaml");
		const exists = existsSync(configPath);
		return {
			target,
			target_contract: AGENT_TARGET_CONTRACTS[target],
			apply_target: configPath,
			apply_status: exists
				? "config exists; generated provider entries not inspected"
				: "not applied",
			applied: null,
		};
	}
	return {
		target,
		target_contract: AGENT_TARGET_CONTRACTS[target],
		apply_target: "openclaw config patch --stdin",
		apply_status: "native config not inspected",
		applied: null,
	};
}
