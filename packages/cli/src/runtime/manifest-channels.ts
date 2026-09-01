import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { isValidSemver } from "../lib/semver";
import { type HermesConfigTransaction, reconcileHermesConfigValue } from "./hermes-config";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import {
	buildHermesManagedChannelsPatch,
	managedChannelHasAccounts,
} from "./managed-channel-reconciliation";
import type { RuntimeManifest } from "./manifest-contract";
import {
	type RuntimeInstallObservation,
	runtimeCommandCurrentRevision,
	runtimeCommandVersion,
	runtimeFileCurrentRevision,
} from "./manifest-install";
import { openClawConfigPatchIsApplied } from "./manifest-providers";
import { canonicalJsonEqual, isPlainRecord, recordValue } from "./manifest-shared";
import { openClawPluginCapabilityConsentArgs } from "./openclaw-plugin-cli";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import {
	runRuntimeUserCommand,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";
import {
	type ManagedWhatsAppAuthCredential,
	managedWhatsAppAuthCredentials,
	managedWhatsAppAuthDir,
} from "./whatsapp-credential-projection";
import {
	CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_METADATA_KEY,
	CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY,
	parseManagedWhatsAppCredentialMetadataJson,
	parseManagedWhatsAppSocketMetadataJson,
} from "./whatsapp-upstream-contract";

export function materializeHostedChannelCredentials(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
): void {
	if (!hostedChannelCredentialsDeclared(manifest)) {
		removeStaleManagedWhatsAppAuthDirs(home, new Set<string>());
		return;
	}
	const credentials = hostedWhatsAppAuthCredentials(manifest);
	const normalizedSecrets = normalizeSecretValues(secretValues);
	const expectedAuthDirs = new Set<string>();
	const errors: string[] = [];
	for (const credential of credentials) {
		try {
			assertManagedWhatsAppAuthDir(home, credential);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		expectedAuthDirs.add(resolve(credential.authDir));
		const credsJson = runtimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
		if (!credsJson) {
			removeManagedWhatsAppAuthDir(credential.authDir);
			errors.push(
				`missing WhatsApp auth state secret for ${credential.accountKey}/${credential.credentialId}`,
			);
			continue;
		}
		try {
			materializeManagedWhatsAppAuthDir(credential, credsJson, home);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	removeStaleManagedWhatsAppAuthDirs(home, expectedAuthDirs);
	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
}
export function validateHostedChannelCredentialsPlan(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
): void {
	if (!hostedChannelCredentialsDeclared(manifest)) return;
	const normalizedSecrets = normalizeSecretValues(secretValues);
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) {
		const credsJson = runtimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
		if (!credsJson) {
			throw new Error(
				`missing WhatsApp auth state secret for ${credential.accountKey}/${credential.credentialId}`,
			);
		}
		inspectManagedWhatsAppAuthDir(credential, credsJson, home);
	}
}
export function hostedChannelCredentialsDeclared(manifest: RuntimeManifest): boolean {
	return Boolean(manifest.projection && Object.hasOwn(manifest.projection, "channelCredentials"));
}
export function hostedWhatsAppAuthCredentials(
	manifest: RuntimeManifest,
): ManagedWhatsAppAuthCredential[] {
	return managedWhatsAppAuthCredentials(manifest.projection?.channelCredentials);
}
function materializeManagedWhatsAppAuthDir(
	credential: ManagedWhatsAppAuthCredential,
	credsJson: string,
	home: string,
): void {
	let inspection: ManagedWhatsAppAuthDirInspection;
	try {
		inspection = inspectManagedWhatsAppAuthDir(credential, credsJson, home);
	} catch (error) {
		if (error instanceof InvalidManagedWhatsAppAuthCredentialError) {
			removeManagedWhatsAppAuthDir(credential.authDir);
		}
		throw error;
	}
	if (
		inspection.existingMetadata?.credentialId &&
		inspection.existingMetadata.credentialId !== credential.credentialId
	) {
		rmSync(credential.authDir, { recursive: true, force: true });
	}

	writePrivateFileAtomic(
		join(credential.authDir, "creds.json"),
		`${JSON.stringify(inspection.creds, null, 2)}\n`,
		{
			mode: 0o600,
			dirMode: 0o700,
		},
	);
}

interface ManagedWhatsAppAuthDirInspection {
	creds: Record<string, unknown>;
	existingMetadata: ManagedWhatsAppAuthMetadata | null;
}

class InvalidManagedWhatsAppAuthCredentialError extends Error {}

function inspectManagedWhatsAppAuthDir(
	credential: ManagedWhatsAppAuthCredential,
	credsJson: string,
	home: string,
): ManagedWhatsAppAuthDirInspection {
	assertManagedWhatsAppAuthDir(home, credential);
	let creds: Record<string, unknown>;
	try {
		const parsed = recordValue(JSON.parse(credsJson) as unknown);
		if (!parsed) throw new Error("creds.json must be a JSON object");
		assertManagedWhatsAppMetadata(parsed, credential);
		creds = parsed;
	} catch (error) {
		throw new InvalidManagedWhatsAppAuthCredentialError(
			`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const existing = existsSync(credential.authDir) ? lstatSync(credential.authDir) : null;
	if (existing?.isSymbolicLink()) {
		throw new Error(
			`refusing to overwrite symlinked WhatsApp auth directory ${credential.authDir}`,
		);
	}
	const existingMetadata = readManagedWhatsAppAuthMetadata(credential.authDir);
	if (
		existing &&
		!existingMetadata &&
		(!existing.isDirectory() || readdirSync(credential.authDir).length > 0)
	) {
		throw new Error(
			`refusing to overwrite unmanaged WhatsApp auth directory ${credential.authDir}`,
		);
	}
	return { creds, existingMetadata };
}

function assertManagedWhatsAppMetadata(
	creds: Record<string, unknown>,
	credential: Pick<ManagedWhatsAppAuthCredential, "accountKey" | "credentialId">,
): void {
	const additionalData = recordValue(creds.additionalData);
	try {
		if (
			!additionalData ||
			!Object.hasOwn(additionalData, CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY)
		) {
			throw new Error("metadata is missing");
		}
		parseManagedWhatsAppSocketMetadataJson(
			additionalData[CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY],
		);
		if (Object.hasOwn(additionalData, CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_METADATA_KEY)) {
			const metadata = parseManagedWhatsAppCredentialMetadataJson(
				additionalData[CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_METADATA_KEY],
			);
			if (metadata.credentialId !== credential.credentialId) {
				throw new Error("credential identity does not match the projection");
			}
		}
	} catch (error) {
		throw new Error(
			`invalid managed WhatsApp metadata for ${credential.accountKey}/${credential.credentialId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
function assertManagedWhatsAppAuthDir(
	home: string,
	credential: ManagedWhatsAppAuthCredential,
): void {
	if (!home) throw new Error("WhatsApp auth credential projection is missing runtime home");
	const resolvedAuthDir = resolve(credential.authDir);
	const expectedAuthDir = managedWhatsAppAuthDir(home, credential.target, credential.accountKey);
	if (resolvedAuthDir !== expectedAuthDir) {
		throw new Error(`WhatsApp auth directory must be ${expectedAuthDir}`);
	}
}
export function managedWhatsAppAuthRoot(
	home: string,
	target: ManagedWhatsAppAuthCredential["target"],
): string | null {
	if (!home) return null;
	return target === "hermes"
		? resolve(home, ".hermes", "platforms", "whatsapp", "session")
		: resolve(home, ".openclaw", "credentials", "whatsapp");
}
interface ManagedWhatsAppAuthFileInspection {
	exists: boolean;
	value: unknown;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function inspectManagedWhatsAppAuthFile(path: string): ManagedWhatsAppAuthFileInspection {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const node = fstatSync(descriptor);
		const effectiveUid = process.geteuid?.();
		if (
			!node.isFile() ||
			(node.mode & 0o022) !== 0 ||
			(effectiveUid !== undefined && node.uid !== effectiveUid)
		) {
			return { exists: true, value: null };
		}
		return { exists: true, value: JSON.parse(readFileSync(descriptor, "utf8")) as unknown };
	} catch (error) {
		return { exists: !isMissingFile(error), value: null };
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
}

export interface ManagedWhatsAppAuthMetadata {
	credentialId: string | null;
}

export function readManagedWhatsAppAuthMetadata(
	authDir: string,
): ManagedWhatsAppAuthMetadata | null {
	return withRuntimeUserFileAccess(() => {
		try {
			const authDirNode = lstatSync(authDir);
			if (!authDirNode.isDirectory() || authDirNode.isSymbolicLink()) return null;
		} catch {
			return null;
		}
		const creds = recordValue(inspectManagedWhatsAppAuthFile(join(authDir, "creds.json")).value);
		const additionalData = recordValue(creds?.additionalData);
		if (
			!additionalData ||
			!Object.hasOwn(additionalData, CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY)
		) {
			return null;
		}
		try {
			parseManagedWhatsAppSocketMetadataJson(
				additionalData[CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY],
			);
			const credentialMetadata = Object.hasOwn(
				additionalData,
				CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_METADATA_KEY,
			)
				? parseManagedWhatsAppCredentialMetadataJson(
						additionalData[CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_METADATA_KEY],
					)
				: null;
			return { credentialId: credentialMetadata?.credentialId ?? null };
		} catch {
			return null;
		}
	});
}

function removeManagedWhatsAppAuthDir(authDir: string): void {
	if (!readManagedWhatsAppAuthMetadata(authDir)) return;
	rmSync(authDir, { recursive: true, force: true });
}
function removeStaleManagedWhatsAppAuthDirs(home: string, expected: Set<string>): void {
	const openclawRoot = managedWhatsAppAuthRoot(home, "openclaw");
	if (openclawRoot && existsSync(openclawRoot)) {
		removeStaleManagedWhatsAppAuthDirsUnderRoot(openclawRoot, expected);
	}
	const hermesAuthDir = managedWhatsAppAuthRoot(home, "hermes");
	if (hermesAuthDir && !expected.has(hermesAuthDir)) {
		removeManagedWhatsAppAuthDir(hermesAuthDir);
	}
}
function removeStaleManagedWhatsAppAuthDirsUnderRoot(root: string, expected: Set<string>): void {
	for (const entry of readdirSync(root)) {
		const authDir = join(root, entry);
		try {
			if (!lstatSync(authDir).isDirectory()) continue;
		} catch {
			continue;
		}
		if (!expected.has(authDir)) {
			removeManagedWhatsAppAuthDir(authDir);
		}
	}
}
export function hostedChannelProjection(manifest: RuntimeManifest): Record<string, unknown> | null {
	if (!manifest.projection || !Object.hasOwn(manifest.projection, "channels")) {
		return null;
	}
	const channels = manifest.projection.channels;
	if (!isPlainRecord(channels)) return null;
	return channels;
}
function applyHermesNestedConfigPatch(
	context: HermesConfigTransaction,
	prefix: string,
	patch: Record<string, unknown>,
): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(patch).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const path = `${prefix}.${key}`;
		if (isPlainRecord(value)) {
			changed = applyHermesNestedConfigPatch(context, path, value) || changed;
			continue;
		}
		changed =
			reconcileHermesConfigValue(context, path, value === null ? undefined : value) || changed;
	}
	return changed;
}
function applyHermesChannelConfig(
	context: HermesConfigTransaction,
	patch: Record<string, unknown>,
): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(patch).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (key === "telegram" || key === "discord" || key === "whatsapp" || key === "display") {
			if (!isPlainRecord(value))
				throw new Error(`Hermes channel patch field ${key} must be an object`);
			changed = applyHermesNestedConfigPatch(context, key, value) || changed;
			continue;
		}
		if (key === "platforms") {
			if (!isPlainRecord(value)) {
				throw new Error("Hermes channel patch field platforms must be an object");
			}
			for (const [platform, platformConfig] of Object.entries(value).sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				if ((platform === "telegram" || platform === "whatsapp") && isPlainRecord(platformConfig)) {
					changed =
						applyHermesNestedConfigPatch(context, `platforms.${platform}`, platformConfig) ||
						changed;
				} else {
					changed =
						reconcileHermesConfigValue(context, `platforms.${platform}`, platformConfig) || changed;
				}
			}
			continue;
		}
		changed =
			reconcileHermesConfigValue(context, key, value === null ? undefined : value) || changed;
	}
	return changed;
}
export function applyHostedChannelProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	openClawContext: OpenClawHostedContext,
	workspaceRoot: string,
	hermesWhatsAppAuthDir: string | null,
	hermesConfig: HermesConfigTransaction | null,
): boolean {
	if (name !== "openclaw" && name !== "hermes") return false;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return false;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return false;

	if (name === "hermes") {
		if (!hermesConfig) throw new Error("Hermes config command is unavailable");
		return applyHermesChannelConfig(
			hermesConfig,
			buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir),
		);
	}
	const currentConfig = readOpenClawConfig(openClawContext.configPath);
	const patch = openClawManagedChannelsPatch(channels, currentConfig);
	if (
		openClawConfigPatchIsApplied(openClawContext, patch) &&
		openClawManagedAccountMapsAreApplied(currentConfig, patch, channels)
	) {
		return false;
	}
	runRuntimeUserCommand(
		observation.commandPath,
		["config", "patch", "--stdin", ...openClawManagedAccountReplaceArgs(channels)],
		`${JSON.stringify(patch, null, 2)}\n`,
		home,
		workspaceRoot,
	);
	return true;
}
export function installHostedChannelProjectionDependencies(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	workspaceRoot: string,
): void {
	if (name !== "openclaw") return;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return;
	installOpenClawChannelPlugins({
		commandPath: observation.commandPath,
		channels,
		home,
		workspaceRoot,
	});
}
function openClawManagedChannelUsesEnvSecretRefs(channels: Record<string, unknown>): boolean {
	return ["telegram", "discord", "whatsapp"].some((channel) =>
		managedChannelHasAccounts(channels[channel]),
	);
}
export function openClawManagedChannelsPatch(
	channels: Record<string, unknown>,
	currentConfig: Record<string, unknown> | null = null,
): Record<string, unknown> {
	const deleteEntries = openClawManagedChannelDeletes();
	const usesEnvSecretRefs = openClawManagedChannelUsesEnvSecretRefs(channels);
	const isolatesManagedDms =
		managedChannelHasAccounts(channels.telegram) ||
		managedChannelHasAccounts(channels.discord) ||
		managedChannelHasAccounts(channels.whatsapp);
	const effectiveChannels = mergeOpenClawManagedAccountPreferences(channels, currentConfig);
	return {
		channels: {
			...deleteEntries,
			...effectiveChannels,
		},
		plugins: {
			entries: {
				...deleteEntries,
				...channelPluginEntries(channels),
			},
		},
		secrets: usesEnvSecretRefs
			? {
					providers: {
						default: { source: "env" },
					},
					defaults: {
						env: "default",
					},
				}
			: undefined,
		session: {
			dmScope: isolatesManagedDms ? "per-account-channel-peer" : null,
		},
	};
}

function readOpenClawConfig(path: string): Record<string, unknown> | null {
	try {
		return recordValue(JSON.parse(readFileSync(path, "utf-8")) as unknown);
	} catch {
		return null;
	}
}

function mergeOpenClawManagedAccountPreferences(
	channels: Record<string, unknown>,
	currentConfig: Record<string, unknown> | null,
): Record<string, unknown> {
	const currentChannels = recordValue(currentConfig?.channels);
	if (!currentChannels) return channels;
	const mergedChannels = { ...channels };
	for (const provider of OPENCLAW_MANAGED_CHANNELS) {
		const desiredChannel = recordValue(channels[provider]);
		const desiredAccounts = recordValue(desiredChannel?.accounts);
		if (!desiredChannel || !desiredAccounts) continue;
		const currentAccounts = recordValue(recordValue(currentChannels[provider])?.accounts);
		const mergedAccounts: Record<string, unknown> = {};
		for (const [accountId, desiredValue] of Object.entries(desiredAccounts)) {
			const desiredAccount = recordValue(desiredValue);
			if (!desiredAccount) {
				mergedAccounts[accountId] = desiredValue;
				continue;
			}
			const currentAccount = recordValue(currentAccounts?.[accountId]);
			const mergedAccount = { ...desiredAccount, ...(currentAccount ?? {}) };
			for (const key of openClawManagedAccountFields(provider)) {
				if (Object.hasOwn(desiredAccount, key)) mergedAccount[key] = desiredAccount[key];
			}
			mergedAccounts[accountId] = mergedAccount;
		}
		mergedChannels[provider] = { ...desiredChannel, accounts: mergedAccounts };
	}
	return mergedChannels;
}

function openClawManagedAccountFields(
	provider: (typeof OPENCLAW_MANAGED_CHANNELS)[number],
): readonly string[] {
	if (provider === "telegram") return ["enabled", "botToken"];
	if (provider === "discord") return ["enabled", "token"];
	return ["enabled", "authDir"];
}

function openClawManagedAccountMapsAreApplied(
	currentConfig: Record<string, unknown> | null,
	patch: Record<string, unknown>,
	channels: Record<string, unknown>,
): boolean {
	const currentChannels = recordValue(currentConfig?.channels);
	const patchedChannels = recordValue(patch.channels);
	for (const provider of OPENCLAW_MANAGED_CHANNELS) {
		const desiredAccounts = recordValue(recordValue(channels[provider])?.accounts);
		if (!desiredAccounts) continue;
		if (!currentChannels || !patchedChannels) return false;
		const currentAccounts = recordValue(recordValue(currentChannels[provider])?.accounts);
		const patchedAccounts = recordValue(recordValue(patchedChannels[provider])?.accounts);
		if (!canonicalJsonEqual(currentAccounts, patchedAccounts)) return false;
	}
	return true;
}
function openClawManagedAccountReplaceArgs(channels: Record<string, unknown>): string[] {
	const args: string[] = [];
	for (const provider of OPENCLAW_MANAGED_CHANNELS) {
		const channel = channels[provider];
		if (!isPlainRecord(channel) || !isPlainRecord(channel.accounts)) continue;
		args.push("--replace-path", `channels.${provider}.accounts`);
	}
	return args;
}
function openClawManagedChannelDeletes(): Record<string, null> {
	return Object.fromEntries(OPENCLAW_MANAGED_CHANNELS.map((channel) => [channel, null])) as Record<
		string,
		null
	>;
}
function installOpenClawChannelPlugins(input: {
	commandPath: string;
	channels: Record<string, unknown>;
	home: string;
	workspaceRoot: string;
}): void {
	for (const channel of Object.keys(input.channels).sort()) {
		const specs = openClawExternalChannelPluginSpecs(channel, input);
		if (!specs) continue;
		const isCurrent = () =>
			channelPluginIsCurrent({
				channel,
				specs,
				commandPath: input.commandPath,
				home: input.home,
				workspaceRoot: input.workspaceRoot,
			});
		if (isCurrent()) continue;
		runPluginInstallWithFallback(input.commandPath, specs, input.home, input.workspaceRoot);
		if (!isCurrent()) {
			throw new Error(`OpenClaw ${channel} channel plugin install could not be verified`);
		}
	}
}
function openClawExternalChannelPluginSpecs(
	channel: string,
	input: { commandPath: string; home: string; workspaceRoot: string },
): readonly string[] | null {
	if (channel !== "whatsapp") return OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS[channel] ?? null;
	const version = normalizeOpenClawRuntimeVersion(
		runtimeCommandVersion(input.commandPath, input.home, input.workspaceRoot) ?? "",
	);
	if (!version) {
		throw new Error("OpenClaw runtime version could not be determined for the WhatsApp plugin");
	}
	return [`clawhub:${OPENCLAW_WHATSAPP_PLUGIN_PACKAGE}@${version}`];
}
function runPluginInstallWithFallback(
	commandPath: string,
	specs: readonly string[],
	home: string,
	workspaceRoot: string,
): void {
	const capabilityConsentArgs = openClawPluginCapabilityConsentArgs("install", (args) => {
		const result = spawnRuntimeUserCommand(commandPath, args, home, workspaceRoot);
		return {
			status: result.status,
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
		};
	});
	let lastError: unknown = null;
	for (const spec of specs) {
		try {
			runRuntimeUserCommand(
				commandPath,
				["plugins", "install", spec, "--force", ...capabilityConsentArgs],
				"",
				home,
				workspaceRoot,
			);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error(`OpenClaw plugin install failed for ${specs.join(" or ")}`);
}
function channelPluginEntries(
	channels: Record<string, unknown>,
): Record<string, { enabled: boolean }> {
	const entries: Record<string, { enabled: boolean }> = {};
	for (const channel of Object.keys(channels).sort()) {
		entries[channel] = { enabled: true };
	}
	return entries;
}
function channelPluginIsCurrent(input: {
	channel: string;
	specs: readonly string[];
	commandPath: string;
	home: string;
	workspaceRoot: string;
}): boolean {
	const commandRevision = runtimeCommandCurrentRevision(
		input.commandPath,
		input.home,
		input.workspaceRoot,
	);
	if (!commandRevision) return false;
	const inspect = spawnRuntimeUserCommand(
		input.commandPath,
		["plugins", "inspect", input.channel, "--json"],
		input.home,
		input.workspaceRoot,
	);
	if (inspect.status !== 0) return false;
	try {
		const stdout = Buffer.isBuffer(inspect.stdout)
			? inspect.stdout.toString("utf8")
			: inspect.stdout;
		const parsed = openClawPluginInspectSchema.safeParse(JSON.parse(stdout) as unknown);
		if (!parsed.success) return false;
		const { plugin, install } = parsed.data;
		const version = plugin.version ?? install.resolvedVersion ?? install.version;
		const sourceRevision = runtimeFileCurrentRevision(plugin.source);
		if (
			plugin.id !== input.channel ||
			!input.specs.some((spec) =>
				openClawPluginInstallMatchesSpec(install, spec, plugin.version),
			) ||
			plugin.status !== "loaded" ||
			!plugin.enabled ||
			!version ||
			!sourceRevision
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}
function openClawPluginInstallMatchesSpec(
	install: z.infer<typeof openClawPluginInspectSchema>["install"],
	spec: string,
	pluginVersion?: string,
): boolean {
	const clawHubSpec = /^clawhub:(.+)@([^@]+)$/.exec(spec);
	if (clawHubSpec) {
		const [, expectedPackage, expectedVersion] = clawHubSpec;
		if (
			install.source !== "clawhub" ||
			install.clawhubPackage !== expectedPackage ||
			!expectedVersion
		) {
			return false;
		}
		const installedVersions = [pluginVersion, install.resolvedVersion, install.version].filter(
			(value): value is string => Boolean(value),
		);
		return (
			installedVersions.length > 0 &&
			installedVersions.every((version) => version === expectedVersion)
		);
	}
	const recordedSpecs = [install.spec, install.resolvedSpec];
	if (install.source === "clawhub" && install.clawhubPackage) {
		recordedSpecs.push(`clawhub:${install.clawhubPackage}`);
	}
	return recordedSpecs.includes(spec);
}
const OPENCLAW_RUNTIME_VERSION_RE =
	/(?:^|[^\d])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:$|[^\dA-Za-z-])/;
const OPENCLAW_WHATSAPP_PLUGIN_PACKAGE = "@openclaw/whatsapp";

export function normalizeOpenClawRuntimeVersion(output: string): string | null {
	const version = OPENCLAW_RUNTIME_VERSION_RE.exec(output)?.[1];
	if (!version) return null;
	const normalized = version.replace(/-\d+$/, "");
	return isValidSemver(normalized) ? normalized : null;
}
export const OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS: Record<string, readonly string[]> = {
	discord: ["@openclaw/discord"],
};
const OPENCLAW_MANAGED_CHANNELS = ["telegram", "discord", "whatsapp"] as const;
