import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	decideChatGptOAuthCredentialReconciliation,
	intentLedgerForDecision,
	type NativeOAuthCredentialObservation,
	type OAuthCredentialLedgerSnapshot,
} from "../lib/chatgpt-oauth-reconciliation";
import {
	HERMES_CODEX_AUTH_HELPER,
	type NativeOAuthCredentialMutationResult,
	nativeOAuthMutationResult,
	nativeOAuthObservation,
	nativeOAuthProfileId,
	type OAuthCredentialOwnership,
	OPENCLAW_CONFIG_MUTATION_EXPORTS,
	OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_HELPER,
	OPENCLAW_PROVIDER_AUTH_CLEANUP_EXPORTS,
	OPENCLAW_PROVIDER_AUTH_HELPER,
	OPENCLAW_PROVIDER_AUTH_MUTATION_EXPORTS,
	OPENCLAW_PROVIDER_ENV_VARS_EXPORTS,
	oauthCredentialFingerprint,
	openClawSdkFunctionGuard,
} from "../lib/codex-oauth-native-store";
import {
	type OAuthCredentialLedger,
	oauthCredentialLedgerPath,
	oauthCredentialLedgerSnapshot,
	readOAuthCredentialLedger,
	writeOAuthCredentialLedger,
} from "../lib/oauth-credential-ledger";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { RuntimeManifest } from "./manifest-contract";
import { tail } from "./manifest-install";
import { recordValue, stringValue } from "./manifest-shared";
import type { RuntimePaths } from "./paths";
import {
	enforceRuntimeUserOwnership,
	runtimeUserDirectoryOwnership,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";

const OPENCLAW_CODEX_PROVIDER_ID = "openai";
interface RuntimeOAuthMaterial {
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	accountId?: string;
	lastRefresh: string;
	expires: number;
}
interface HostedRuntimeOAuthCredential {
	providerId: string;
	profile: string;
	credentialRevision: string;
	material: RuntimeOAuthMaterial;
}
type RuntimeOAuthCredentialAction = "inspect" | "seed-if-missing" | "upsert" | "remove";
interface RuntimeOAuthCredentialCommand {
	action: RuntimeOAuthCredentialAction;
	nativeProfileId: string;
	credentialRevision: string;
	material?: RuntimeOAuthMaterial;
	ownership?: OAuthCredentialOwnership;
	expectedFingerprint?: string;
}
interface RuntimeOAuthCredentialDriver {
	observe: (
		input: Omit<RuntimeOAuthCredentialCommand, "action" | "material" | "expectedFingerprint">,
	) => NativeOAuthCredentialObservation;
	mutate: (
		input: Omit<RuntimeOAuthCredentialCommand, "action"> & {
			action: Exclude<RuntimeOAuthCredentialAction, "inspect">;
		},
	) => NativeOAuthCredentialMutationResult;
}
function runtimeOAuthLedgerPath(
	paths: RuntimePaths,
	runtime: "hermes" | "openclaw",
	providerId: string,
): string {
	return oauthCredentialLedgerPath(paths.oauthCredentialRoot, runtime, providerId);
}
function writeRuntimeOAuthLedger(
	path: string,
	runtime: "hermes" | "openclaw",
	providerId: string,
	snapshot: OAuthCredentialLedgerSnapshot,
): void {
	writeOAuthCredentialLedger(path, { runtime, providerId }, snapshot);
}
function readRuntimeOAuthLedger(path: string): OAuthCredentialLedger | null {
	return readOAuthCredentialLedger(path, { migrateLegacy: true });
}
function decodeJwtExpiryMs(token: string): number | null {
	const encoded = token.split(".")[1];
	if (!encoded) return null;
	try {
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
		const exp = recordValue(payload)?.exp;
		return typeof exp === "number" && Number.isFinite(exp) ? Math.trunc(exp * 1000) : null;
	} catch {
		return null;
	}
}
function parseHostedRuntimeOAuthMaterial(payload: string): RuntimeOAuthMaterial {
	const envelope = recordValue(JSON.parse(payload) as unknown);
	if (envelope?.kind !== "local_agent_profile" || !Array.isArray(envelope.files)) {
		throw new Error("hosted OAuth secret is not a local Agent credential profile");
	}
	const authFile = envelope.files
		.map(recordValue)
		.find((file) => file?.logicalName === "auth.json");
	if (!authFile || typeof authFile.content !== "string") {
		throw new Error("hosted OAuth credential profile is missing auth.json");
	}
	const auth = recordValue(JSON.parse(authFile.content) as unknown);
	const tokens = recordValue(auth?.tokens);
	const accessToken = stringValue(tokens?.access_token);
	const refreshToken = stringValue(tokens?.refresh_token);
	if (!accessToken || !refreshToken) {
		throw new Error("hosted OAuth credential profile is missing access or refresh token");
	}
	return {
		accessToken,
		refreshToken,
		...(stringValue(tokens?.id_token)
			? { idToken: stringValue(tokens?.id_token) ?? undefined }
			: {}),
		...(stringValue(tokens?.account_id)
			? { accountId: stringValue(tokens?.account_id) ?? undefined }
			: {}),
		lastRefresh: stringValue(auth?.last_refresh) ?? new Date().toISOString(),
		expires: decodeJwtExpiryMs(accessToken) ?? Date.now() + 60 * 60 * 1000,
	};
}
function hostedRuntimeOAuthCredentials(
	manifest: RuntimeManifest,
	runtime: "hermes" | "openclaw",
	secretValues: Record<string, string> | undefined,
): HostedRuntimeOAuthCredential[] {
	if (manifest.runtimes[runtime]?.enabled !== true) return [];
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return [];
	return (manifest.runtimes[runtime]?.provider_ids ?? []).flatMap((providerId) => {
		const raw = providers[providerId];
		const provider = recordValue(raw);
		const auth = recordValue(provider?.auth);
		if (
			auth?.type !== "agent_profile" ||
			auth.tool !== "codex" ||
			typeof auth.profile !== "string" ||
			typeof auth.credentialSecretRef !== "string" ||
			typeof auth.credentialRevision !== "string"
		) {
			return [];
		}
		const payload = runtimeSecretValue(secretValues ?? {}, auth.credentialSecretRef);
		if (!payload) throw new Error(`hosted OAuth secret is unavailable for ${providerId}`);
		return [
			{
				providerId,
				profile: auth.profile,
				credentialRevision: auth.credentialRevision,
				material: parseHostedRuntimeOAuthMaterial(payload),
			},
		];
	});
}
export function hermesAuthPath(home: string): string {
	return join(home, ".hermes", "auth.json");
}
function runHermesCodexAuthCommand(
	home: string,
	workspaceRoot: string,
	input: RuntimeOAuthCredentialCommand,
): Record<string, unknown> {
	const authPath = hermesAuthPath(home);
	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(dirname(authPath), { mode: 0o700, ancestorsUnder: home }),
	);
	const result = spawnRuntimeUserCommand(
		"flock",
		[
			"--timeout",
			"10",
			join(dirname(authPath), "auth.lock"),
			"node",
			"--input-type=module",
			"--eval",
			HERMES_CODEX_AUTH_HELPER,
			authPath,
			input.action,
			input.nativeProfileId,
			input.ownership?.nativeProfileId ?? "",
			input.credentialRevision,
			input.expectedFingerprint ?? "",
		],
		home,
		workspaceRoot,
		{ input: input.material ? JSON.stringify(input.material) : "null" },
	);
	if (result.status !== 0) {
		throw new Error(
			`Hermes Codex auth ${input.action} failed: ${tail(String(result.stderr ?? "")) ?? "unknown"}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	return output ?? {};
}
const OPENCLAW_OWNER_BROWSER_BOOTSTRAP_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
const normalized = typeof sdk.normalizeDeviceBootstrapProfile === "function"
  ? sdk.normalizeDeviceBootstrapProfile({ purpose: "control-ui-owner" })
  : null;
process.stdout.write(normalized?.purpose === "control-ui-owner" ? "supported" : "unsupported");
`;
export function openClawSupportsOwnerBrowserBootstrap(context: OpenClawHostedContext): boolean {
	const sdkPath = context.sdk.deviceBootstrap;
	if (!sdkPath) return false;
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	const result = spawnRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_OWNER_BROWSER_BOOTSTRAP_CAPABILITY_PROBE, sdkPath],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw device-bootstrap capability probe failed: ${
				tail(String(result.stderr ?? "")) ?? "unknown"
			}`,
		);
	}
	const outcome = String(result.stdout ?? "").trim();
	if (outcome === "supported") return true;
	if (outcome === "unsupported") return false;
	throw new Error("installed OpenClaw device-bootstrap capability probe returned invalid output");
}
const OPENCLAW_PROVIDER_AUTH_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (${openClawSdkFunctionGuard("sdk", OPENCLAW_PROVIDER_AUTH_MUTATION_EXPORTS)}) {
  throw new Error("required public provider-auth exports are missing");
}
`;
const OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const providerAuth = await import(pathToFileURL(process.argv[1]).href);
const configMutation = await import(pathToFileURL(process.argv[2]).href);
const providerEnvVars = await import(pathToFileURL(process.argv[3]).href);
if (
  ${openClawSdkFunctionGuard("providerAuth", OPENCLAW_PROVIDER_AUTH_CLEANUP_EXPORTS)} ||
  ${openClawSdkFunctionGuard("configMutation", OPENCLAW_CONFIG_MUTATION_EXPORTS)} ||
  ${openClawSdkFunctionGuard("providerEnvVars", OPENCLAW_PROVIDER_ENV_VARS_EXPORTS)}
) {
  throw new Error("required public OpenClaw auth cleanup exports are missing");
}
`;
function requireOpenClawProviderAuthCapability(context: OpenClawHostedContext): void {
	const sdkPath = context.requireSdkExport("providerAuth");
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	const result = spawnRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_PROVIDER_AUTH_CAPABILITY_PROBE, sdkPath],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw public provider-auth SDK is incompatible: ${
				tail(String(result.stderr ?? "")) ?? "capability probe failed"
			}`,
		);
	}
}
function requireOpenClawManagedProviderAuthCleanupCapability(context: OpenClawHostedContext): void {
	const providerAuthSdkPath = context.requireSdkExport("providerAuth");
	const configMutationSdkPath = context.sdk.configMutation;
	if (!configMutationSdkPath) {
		throw new Error("installed OpenClaw public config-mutation SDK export is unavailable");
	}
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_CAPABILITY_PROBE,
			providerAuthSdkPath,
			configMutationSdkPath,
			context.requireSdkExport("providerEnvVars"),
		],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw public managed-provider auth cleanup SDK is incompatible: ${
				tail(String(result.stderr ?? "")) ?? "capability probe failed"
			}`,
		);
	}
}
export function ensureHostedOpenClawProviderAuthCapability(input: {
	manifest: RuntimeManifest;
	secretValues: Record<string, string> | undefined;
	context: OpenClawHostedContext;
}): void {
	const desired = hostedRuntimeOAuthCredentials(input.manifest, "openclaw", input.secretValues);
	const cleanupManagedProvider = input.context.managedApiKeyProjection;
	if (desired.length === 0 && !cleanupManagedProvider) return;
	const requirement =
		desired.length > 0 && cleanupManagedProvider
			? "OpenClaw credential convergence"
			: cleanupManagedProvider
				? "OpenClaw managed API-key cleanup"
				: "OpenClaw OAuth";
	try {
		if (desired.length > 0) requireOpenClawProviderAuthCapability(input.context);
		if (cleanupManagedProvider) {
			requireOpenClawManagedProviderAuthCleanupCapability(input.context);
		}
	} catch (initialError) {
		const detail = initialError instanceof Error ? initialError.message : String(initialError);
		throw new Error(
			`${requirement} requires the public OpenClaw SDK; automatic runtime reinstall is disabled: ${
				tail(detail) ?? "capability probe failed"
			}`,
		);
	}
}
function runOpenClawProviderAuthCommand(
	context: OpenClawHostedContext,
	workspaceRoot: string,
	input: RuntimeOAuthCredentialCommand,
): Record<string, unknown> {
	const credential = input.material
		? JSON.stringify({
				type: "oauth",
				provider: OPENCLAW_CODEX_PROVIDER_ID,
				access: input.material.accessToken,
				refresh: input.material.refreshToken,
				expires: input.material.expires,
				...(input.material.idToken ? { idToken: input.material.idToken } : {}),
				...(input.material.accountId ? { accountId: input.material.accountId } : {}),
				copyToAgents: false,
			})
		: "";
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_PROVIDER_AUTH_HELPER,
			context.requireSdkExport("providerAuth"),
			context.agentDirs.main,
			input.action,
			input.nativeProfileId,
			input.ownership?.nativeProfileId ?? "",
			input.credentialRevision,
			input.expectedFingerprint ?? "",
		],
		context.home,
		workspaceRoot,
		{ input: credential || "null" },
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw provider-auth ${input.action} failed: ${tail(String(result.stderr ?? "")) ?? "unknown"}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	return output ?? {};
}
export function removeOpenClawManagedProviderAuthProfiles(
	context: OpenClawHostedContext,
	workspaceRoot: string,
): void {
	const configMutationSdkPath = context.sdk.configMutation;
	if (!configMutationSdkPath) {
		throw new Error("installed OpenClaw public config-mutation SDK export is unavailable");
	}
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_HELPER,
			context.requireSdkExport("providerAuth"),
			configMutationSdkPath,
			context.home,
			"cleanup",
			JSON.stringify(context.agentDirs.managed),
		],
		context.home,
		workspaceRoot,
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw managed provider-auth cleanup failed: ${
				tail(String(result.stderr || result.stdout || "")) ?? "unknown"
			}`,
		);
	}
}
export function discoverOpenClawManagedProviderAuthAgentDirs(
	context: OpenClawHostedContext,
): string[] {
	const configMutationSdkPath = context.sdk.configMutation;
	if (!configMutationSdkPath) {
		throw new Error("installed OpenClaw public config-mutation SDK export is unavailable");
	}
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_HELPER,
			context.requireSdkExport("providerAuth"),
			configMutationSdkPath,
			context.home,
			"discover",
		],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw managed provider-auth store discovery failed: ${
				tail(String(result.stderr || result.stdout || "")) ?? "unknown"
			}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	if (!output || !Array.isArray(output.agentDirs)) {
		throw new Error("OpenClaw managed provider-auth store discovery returned invalid output");
	}
	const agentDirs = output.agentDirs.filter((path): path is string => typeof path === "string");
	if (agentDirs.length !== output.agentDirs.length || agentDirs.length === 0) {
		throw new Error("OpenClaw managed provider-auth store discovery returned invalid targets");
	}
	return agentDirs;
}
function runtimeOAuthLedgerOwnership(
	ledger: OAuthCredentialLedger | null,
): OAuthCredentialOwnership | undefined {
	if (!ledger) return undefined;
	const credentialFingerprint =
		ledger.state === "seeded"
			? ledger.credentialFingerprint
			: ledger.state === "intent" && ledger.operation === "remove"
				? ledger.beforeCredentialFingerprint
				: undefined;
	if (ledger.state !== "seeded" && !(ledger.state === "intent" && ledger.operation === "remove")) {
		return undefined;
	}
	return {
		nativeProfileId: ledger.nativeProfileId,
		...(credentialFingerprint
			? {
					credentialRevision: ledger.credentialRevision,
					credentialFingerprint,
				}
			: {}),
	};
}
function runtimeOAuthCredentialDriver(
	run: (input: RuntimeOAuthCredentialCommand) => Record<string, unknown>,
): RuntimeOAuthCredentialDriver {
	return {
		observe: (input) => nativeOAuthObservation(run({ ...input, action: "inspect" })),
		mutate: (input) => nativeOAuthMutationResult(run(input)),
	};
}
function hostedRuntimeOAuthCredentialDriver(input: {
	runtime: "hermes" | "openclaw";
	home: string;
	openClawContext: OpenClawHostedContext;
	workspaceRoot: string;
}): RuntimeOAuthCredentialDriver {
	if (input.runtime === "hermes") {
		return runtimeOAuthCredentialDriver((command) =>
			runHermesCodexAuthCommand(input.home, input.workspaceRoot, command),
		);
	}
	return runtimeOAuthCredentialDriver((command) =>
		runOpenClawProviderAuthCommand(input.openClawContext, input.workspaceRoot, command),
	);
}
function executeHostedRuntimeOAuthAction(input: {
	decision: ReturnType<typeof decideChatGptOAuthCredentialReconciliation>;
	driver: RuntimeOAuthCredentialDriver;
	runtime: "hermes" | "openclaw";
	nativeProfileId: string;
	credentialRevision: string;
	material: RuntimeOAuthMaterial;
}): void {
	const action = input.decision.nativeAction;
	if (action === "preserve") return;
	if (action === "remove") {
		throw new Error("Desired hosted OAuth reconciliation cannot remove a credential");
	}
	const adapterAction = action === "seed" ? "seed-if-missing" : "upsert";
	const expectedFingerprint =
		action === "seed"
			? "missing"
			: requireRuntimeDecisionFingerprint(input.decision.expectedCredentialFingerprint, "before");
	const targetFingerprint = requireRuntimeDecisionFingerprint(
		input.decision.targetCredentialFingerprint,
		"target",
	);
	const result = input.driver.mutate({
		action: adapterAction,
		nativeProfileId: input.nativeProfileId,
		credentialRevision: input.credentialRevision,
		material: input.material,
		expectedFingerprint,
	});
	assertRuntimeNativeMutationCompleted(
		result,
		expectedFingerprint,
		targetFingerprint,
		`${input.runtime} OAuth credential`,
	);
}
function removeHostedRuntimeOAuthCredential(input: {
	driver: RuntimeOAuthCredentialDriver;
	runtime: "hermes" | "openclaw";
	nativeProfileId: string;
	credentialRevision: string;
	ownership: OAuthCredentialOwnership;
	expectedFingerprint: string;
}): void {
	const result = input.driver.mutate({
		action: "remove",
		nativeProfileId: input.nativeProfileId,
		credentialRevision: input.credentialRevision,
		ownership: input.ownership,
		expectedFingerprint: input.expectedFingerprint,
	});
	assertRuntimeNativeRemovalCompleted(
		result,
		input.expectedFingerprint,
		`${input.runtime} OAuth credential`,
	);
}
function requireRuntimeDecisionFingerprint(value: string | undefined, label: string): string {
	if (!value) throw new Error(`OAuth credential decision is missing ${label} fingerprint evidence`);
	return value;
}
function assertRuntimeNativeMutationCompleted(
	result: NativeOAuthCredentialMutationResult,
	expectedFingerprint: string,
	targetFingerprint: string,
	label: string,
): void {
	if (!result.casMatched) throw new Error(`${label} changed before the mutation could be applied`);
	assertRuntimeNativeMutationBeforeEvidence(result, expectedFingerprint, label);
	if (!result.updated || result.afterCredentialFingerprint !== targetFingerprint) {
		throw new Error(`${label} mutation did not produce the intended fingerprint`);
	}
}
function assertRuntimeNativeRemovalCompleted(
	result: NativeOAuthCredentialMutationResult,
	expectedFingerprint: string,
	label: string,
): void {
	if (!result.casMatched) throw new Error(`${label} changed before removal could be applied`);
	assertRuntimeNativeMutationBeforeEvidence(result, expectedFingerprint, label);
	if (!result.updated || result.afterCredentialFingerprint) {
		throw new Error(`${label} removal could not verify absence`);
	}
}
function assertRuntimeNativeMutationBeforeEvidence(
	result: NativeOAuthCredentialMutationResult,
	expectedFingerprint: string,
	label: string,
): void {
	const matches =
		expectedFingerprint === "missing"
			? result.beforeCredentialFingerprint === undefined
			: result.beforeCredentialFingerprint === expectedFingerprint;
	if (!matches) throw new Error(`${label} mutation returned inconsistent before evidence`);
}
export function reconcileHostedRuntimeOAuthCredentials(input: {
	runtime: "hermes" | "openclaw";
	manifest: RuntimeManifest;
	secretValues: Record<string, string> | undefined;
	paths: RuntimePaths;
	home: string;
	openClawContext: OpenClawHostedContext;
	workspaceRoot: string;
}): void {
	const desired = hostedRuntimeOAuthCredentials(input.manifest, input.runtime, input.secretValues);
	const driver = hostedRuntimeOAuthCredentialDriver(input);
	const desiredProviderIds = new Set(desired.map((credential) => credential.providerId));
	const ledgerDir = join(input.paths.oauthCredentialRoot, input.runtime);
	if (existsSync(ledgerDir)) {
		for (const filename of readdirSync(ledgerDir).filter((name) => name.endsWith(".json"))) {
			const path = join(ledgerDir, filename);
			const ledger = readRuntimeOAuthLedger(path);
			if (!ledger || desiredProviderIds.has(ledger.providerId) || ledger.state === "retired") {
				continue;
			}
			const snapshot = oauthCredentialLedgerSnapshot(ledger);
			const ownership = runtimeOAuthLedgerOwnership(ledger);
			const native = driver.observe({
				nativeProfileId: ledger.nativeProfileId,
				credentialRevision: ledger.credentialRevision,
				ownership,
			});
			const decision = decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				desiredCredentialFingerprint: null,
				ledger: snapshot,
				native,
			});
			if (decision.requiresWriteAheadIntent) {
				writeRuntimeOAuthLedger(
					path,
					input.runtime,
					ledger.providerId,
					intentLedgerForDecision(decision),
				);
			}
			if (decision.nativeAction === "remove") {
				const expectedFingerprint = requireRuntimeDecisionFingerprint(
					decision.expectedCredentialFingerprint,
					"before",
				);
				const removalOwnership = ownership ?? {
					nativeProfileId: ledger.nativeProfileId,
					credentialRevision: ledger.credentialRevision,
					credentialFingerprint: expectedFingerprint,
				};
				removeHostedRuntimeOAuthCredential({
					driver,
					runtime: input.runtime,
					nativeProfileId: ledger.nativeProfileId,
					credentialRevision: ledger.credentialRevision,
					ownership: removalOwnership,
					expectedFingerprint,
				});
			}
			writeRuntimeOAuthLedger(path, input.runtime, ledger.providerId, decision.nextLedger);
		}
	}
	for (const credential of desired) {
		const ledgerPath = runtimeOAuthLedgerPath(input.paths, input.runtime, credential.providerId);
		const ledger = readRuntimeOAuthLedger(ledgerPath);
		const snapshot = oauthCredentialLedgerSnapshot(ledger);
		const nativeProfileId = nativeOAuthProfileId(input.runtime, credential.providerId);
		const desiredFingerprint = oauthCredentialFingerprint(
			credential.credentialRevision,
			credential.material.accessToken,
			credential.material.refreshToken,
		);
		const native = driver.observe({
			nativeProfileId,
			credentialRevision: credential.credentialRevision,
			ownership: runtimeOAuthLedgerOwnership(ledger),
		});
		const decision = decideChatGptOAuthCredentialReconciliation({
			desiredCredentialRevision: credential.credentialRevision,
			desiredNativeProfileId: nativeProfileId,
			desiredCredentialFingerprint: desiredFingerprint,
			ledger: snapshot,
			native,
		});
		if (decision.requiresWriteAheadIntent) {
			writeRuntimeOAuthLedger(
				ledgerPath,
				input.runtime,
				credential.providerId,
				intentLedgerForDecision(decision),
			);
		}
		executeHostedRuntimeOAuthAction({
			decision,
			driver,
			runtime: input.runtime,
			nativeProfileId,
			credentialRevision: credential.credentialRevision,
			material: credential.material,
		});
		writeRuntimeOAuthLedger(ledgerPath, input.runtime, credential.providerId, decision.nextLedger);
	}
}
