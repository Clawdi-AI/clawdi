import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { runtimeContentSha256 } from "./applied-state";
import { type HermesConfigCommandContext, reconcileHermesConfigValue } from "./hermes-config";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { RuntimeInstallReceipts } from "./install-receipts";
import {
	buildHermesManagedChannelsPatch,
	managedChannelHasAccounts,
} from "./managed-channel-reconciliation";
import type { RuntimeManifest } from "./manifest-contract";
import {
	type RuntimeInstallObservation,
	type RuntimeInstallReceiptTarget,
	type RuntimeInstallReceiptTargets,
	runtimeCommandCurrentRevision,
	runtimeFileCurrentRevision,
	verifiedReceiptCurrentRevision,
} from "./manifest-install";
import { openClawConfigPatchIsApplied } from "./manifest-providers";
import { hermesConfigContext } from "./manifest-runtime-config";
import { isPlainRecord, recordValue, stringValue, writeJsonFile } from "./manifest-shared";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import {
	enforceRuntimeUserOwnership,
	makeRuntimeUserOwned,
	runRuntimeUserCommand,
	runtimeUserDirectoryOwnership,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";
import {
	type ManagedWhatsAppAuthCredential,
	managedWhatsAppAuthCredentials,
} from "./whatsapp-credential-projection";
import {
	CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY,
	parseManagedWhatsAppSocketMetadataJson,
} from "./whatsapp-upstream-contract";

const MANAGED_WHATSAPP_AUTH_MARKER = ".clawdi-managed-whatsapp-auth.json";
// SUNSET: Remove after every fleet host has converged past the retired Hermes WhatsApp receipt writer.
export const RETIRED_MANAGED_HERMES_WHATSAPP_RECEIPT = "hermes-whatsapp.json";
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
		const authDirError = managedWhatsAppAuthDirError(home, credential);
		if (authDirError) {
			errors.push(authDirError);
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
		const authDirError = managedWhatsAppAuthDirError(home, credential);
		if (authDirError) throw new Error(authDirError);
		const credsJson = runtimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
		if (!credsJson) {
			throw new Error(
				`missing WhatsApp auth state secret for ${credential.accountKey}/${credential.credentialId}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(credsJson);
		} catch (error) {
			throw new Error(
				`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const parsedCreds = recordValue(parsed);
		if (!parsedCreds) {
			throw new Error(
				`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: creds.json must be a JSON object`,
			);
		}
		assertManagedWhatsAppMetadata(parsedCreds, credential);
		if (existsSync(credential.authDir) && lstatSync(credential.authDir).isSymbolicLink()) {
			throw new Error(
				`refusing to overwrite symlinked WhatsApp auth directory ${credential.authDir}`,
			);
		}
		const existingMarker = readManagedWhatsAppAuthMarker(credential.authDir);
		if (
			existsSync(credential.authDir) &&
			!existingMarker &&
			readdirSync(credential.authDir).length > 0
		) {
			throw new Error(
				`refusing to overwrite unmanaged WhatsApp auth directory ${credential.authDir}`,
			);
		}
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
	let parsedCreds: Record<string, unknown>;
	try {
		const parsed = JSON.parse(credsJson) as unknown;
		const record = recordValue(parsed);
		if (!record) {
			throw new Error("creds.json must be a JSON object");
		}
		parsedCreds = record;
		assertManagedWhatsAppMetadata(parsedCreds, credential);
	} catch (error) {
		removeManagedWhatsAppAuthDir(credential.authDir);
		throw new Error(
			`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (existsSync(credential.authDir) && lstatSync(credential.authDir).isSymbolicLink()) {
		throw new Error(
			`refusing to overwrite symlinked WhatsApp auth directory ${credential.authDir}`,
		);
	}
	const existingMarker = readManagedWhatsAppAuthMarker(credential.authDir);
	if (existingMarker && existingMarker.credentialId !== credential.credentialId) {
		rmSync(credential.authDir, { recursive: true, force: true });
	} else if (existsSync(credential.authDir) && !existingMarker) {
		const entries = readdirSync(credential.authDir);
		if (entries.length > 0) {
			throw new Error(
				`refusing to overwrite unmanaged WhatsApp auth directory ${credential.authDir}`,
			);
		}
	}

	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(credential.authDir, { mode: 0o700, ancestorsUnder: home }),
	);
	writePrivateFileAtomic(
		join(credential.authDir, "creds.json"),
		`${JSON.stringify(parsedCreds, null, 2)}\n`,
		{
			mode: 0o600,
			dirMode: 0o700,
		},
	);
	makeRuntimeUserOwned(join(credential.authDir, "creds.json"));
	writeJsonFile(join(credential.authDir, MANAGED_WHATSAPP_AUTH_MARKER), {
		schemaVersion: "clawdi.managedWhatsAppAuth.v1",
		provider: "whatsapp",
		target: credential.target,
		accountKey: credential.accountKey,
		credentialId: credential.credentialId,
	});
	makeRuntimeUserOwned(join(credential.authDir, MANAGED_WHATSAPP_AUTH_MARKER));
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
	} catch (error) {
		throw new Error(
			`invalid managed WhatsApp metadata for ${credential.accountKey}/${credential.credentialId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
function managedWhatsAppAuthDirError(
	home: string,
	credential: ManagedWhatsAppAuthCredential,
): string | null {
	const root = managedWhatsAppAuthRoot(home, credential.target);
	if (!root) return "WhatsApp auth credential projection is missing runtime home";
	const resolvedAuthDir = resolve(credential.authDir);
	if (credential.target === "hermes") {
		return resolvedAuthDir === root ? null : `WhatsApp auth directory must be ${root}`;
	}
	const relativePath = relative(root, resolvedAuthDir);
	if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return null;
	}
	return `WhatsApp auth directory must be under ${root}`;
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
interface ManagedWhatsAppAuthMarker {
	schemaVersion: "clawdi.managedWhatsAppAuth.v1";
	provider: "whatsapp";
	target: ManagedWhatsAppAuthCredential["target"];
	accountKey: string;
	credentialId: string;
}
export function readManagedWhatsAppAuthMarker(authDir: string): ManagedWhatsAppAuthMarker | null {
	const markerPath = join(authDir, MANAGED_WHATSAPP_AUTH_MARKER);
	try {
		if (!lstatSync(markerPath).isFile()) return null;
		const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as unknown;
		const record = recordValue(parsed);
		const target = record ? stringValue(record.target) : null;
		const accountKey = record ? stringValue(record.accountKey) : null;
		const credentialId = record ? stringValue(record.credentialId) : null;
		if (
			record?.schemaVersion !== "clawdi.managedWhatsAppAuth.v1" ||
			record.provider !== "whatsapp" ||
			(target !== "openclaw" && target !== "hermes" && target !== "legacy") ||
			!accountKey ||
			!credentialId
		) {
			return null;
		}
		return {
			schemaVersion: "clawdi.managedWhatsAppAuth.v1",
			provider: "whatsapp",
			target,
			accountKey,
			credentialId,
		};
	} catch {
		return null;
	}
}
function removeManagedWhatsAppAuthDir(authDir: string): void {
	if (!readManagedWhatsAppAuthMarker(authDir)) return;
	rmSync(authDir, { recursive: true, force: true });
}
function removeManagedHermesWhatsAppAuthDir(authDir: string): void {
	const marker = readManagedWhatsAppAuthMarker(authDir);
	if (marker?.target !== "hermes") return;
	rmSync(authDir, { recursive: true, force: true });
}
function removeStaleManagedWhatsAppAuthDirs(home: string, expected: Set<string>): void {
	const openclawRoot = managedWhatsAppAuthRoot(home, "openclaw");
	if (openclawRoot && existsSync(openclawRoot)) {
		removeStaleManagedWhatsAppAuthDirsUnderRoot(openclawRoot, expected);
	}
	const hermesAuthDir = managedWhatsAppAuthRoot(home, "hermes");
	if (hermesAuthDir && !expected.has(hermesAuthDir)) {
		removeManagedHermesWhatsAppAuthDir(hermesAuthDir);
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
	context: HermesConfigCommandContext,
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
	context: HermesConfigCommandContext,
	patch: Record<string, unknown>,
): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(patch).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (key === "telegram" || key === "discord") {
			changed = reconcileHermesConfigValue(context, key, value) || changed;
			continue;
		}
		if (key === "whatsapp" || key === "display") {
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
): boolean {
	if (name !== "openclaw" && name !== "hermes") return false;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return false;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return false;

	if (name === "hermes") {
		return applyHermesChannelConfig(
			hermesConfigContext(observation, home, workspaceRoot),
			buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir),
		);
	}
	const patch = openClawManagedChannelsPatch(channels);
	if (openClawConfigPatchIsApplied(openClawContext, patch)) return false;
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
	previousReceipts: RuntimeInstallReceipts | null,
	receiptTargets: RuntimeInstallReceiptTargets,
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
		previousReceipts,
		receiptTargets,
	});
}
function openClawManagedChannelUsesEnvSecretRefs(channels: Record<string, unknown>): boolean {
	return ["telegram", "discord", "whatsapp"].some((channel) =>
		managedChannelHasAccounts(channels[channel]),
	);
}
export function openClawManagedChannelsPatch(
	channels: Record<string, unknown>,
): Record<string, unknown> {
	const deleteEntries = openClawManagedChannelDeletes();
	const usesEnvSecretRefs = openClawManagedChannelUsesEnvSecretRefs(channels);
	const isolatesManagedDms =
		managedChannelHasAccounts(channels.telegram) ||
		managedChannelHasAccounts(channels.discord) ||
		managedChannelHasAccounts(channels.whatsapp);
	return {
		channels: {
			...deleteEntries,
			...channels,
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
	previousReceipts: RuntimeInstallReceipts | null;
	receiptTargets: RuntimeInstallReceiptTargets;
}): void {
	for (const channel of Object.keys(input.channels).sort()) {
		const specs = OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS[channel];
		if (!specs) continue;
		const key = `openclaw:${channel}`;
		const desiredRevision = channelPluginDesiredRevision({
			channel,
			specs,
		});
		const currentRevision = () =>
			channelPluginCurrentRevision({
				channel,
				specs,
				commandPath: input.commandPath,
				home: input.home,
				workspaceRoot: input.workspaceRoot,
			});
		const verifiedCurrentRevision = verifiedReceiptCurrentRevision(
			input.previousReceipts?.channelPlugins[key],
			desiredRevision,
			currentRevision,
		);
		const target: RuntimeInstallReceiptTarget = {
			desiredRevision,
			currentRevision,
			expectedCurrentRevision: verifiedCurrentRevision,
		};
		input.receiptTargets.channelPlugins.set(key, target);
		if (verifiedCurrentRevision !== null) continue;
		runPluginInstallWithFallback(input.commandPath, specs, input.home, input.workspaceRoot);
		const installedRevision = currentRevision();
		if (!installedRevision) {
			throw new Error(`OpenClaw ${channel} channel plugin install could not be verified`);
		}
		target.expectedCurrentRevision = installedRevision;
	}
}
function runPluginInstallWithFallback(
	commandPath: string,
	specs: readonly string[],
	home: string,
	workspaceRoot: string,
): void {
	let lastError: unknown = null;
	for (const spec of specs) {
		try {
			runRuntimeUserCommand(
				commandPath,
				["plugins", "install", spec, "--force"],
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
function channelPluginDesiredRevision(input: {
	channel: string;
	specs: readonly string[];
}): string {
	return runtimeContentSha256({
		runtime: "openclaw",
		pluginIdentity: input.channel,
		installerCommand: ["plugins", "install", "--force"],
		specs: input.specs,
	});
}
function channelPluginCurrentRevision(input: {
	channel: string;
	specs: readonly string[];
	commandPath: string;
	home: string;
	workspaceRoot: string;
}): string | null {
	const commandRevision = runtimeCommandCurrentRevision(
		input.commandPath,
		input.home,
		input.workspaceRoot,
	);
	if (!commandRevision) return null;
	const inspect = spawnRuntimeUserCommand(
		input.commandPath,
		["plugins", "inspect", input.channel, "--json"],
		input.home,
		input.workspaceRoot,
	);
	if (inspect.status !== 0) return null;
	try {
		const stdout = Buffer.isBuffer(inspect.stdout)
			? inspect.stdout.toString("utf8")
			: inspect.stdout;
		const parsed = openClawPluginInspectSchema.safeParse(JSON.parse(stdout) as unknown);
		if (!parsed.success) return null;
		const { plugin, install } = parsed.data;
		const version = plugin.version ?? install.resolvedVersion ?? install.version;
		const sourceRevision = runtimeFileCurrentRevision(plugin.source);
		if (
			plugin.id !== input.channel ||
			!input.specs.some((spec) => openClawPluginInstallMatchesSpec(install, spec)) ||
			plugin.status !== "loaded" ||
			!plugin.enabled ||
			!version ||
			!sourceRevision
		) {
			return null;
		}
		return runtimeContentSha256({
			commandRevision,
			plugin: {
				id: plugin.id,
				source: plugin.source,
				sourceRevision,
				origin: plugin.origin,
				status: plugin.status,
				version,
				enabled: plugin.enabled === true,
			},
			install: {
				source: install.source,
				spec: install.spec,
				sourcePath: install.sourcePath,
				installPath: install.installPath,
				version: install.version,
				resolvedName: install.resolvedName,
				resolvedVersion: install.resolvedVersion,
				resolvedSpec: install.resolvedSpec,
				integrity: install.integrity,
				shasum: install.shasum,
				npmIntegrity: install.npmIntegrity,
				npmShasum: install.npmShasum,
				clawpackSha256: install.clawpackSha256,
				gitUrl: install.gitUrl,
				gitRef: install.gitRef,
				gitCommit: install.gitCommit,
			},
		});
	} catch {
		return null;
	}
}
function openClawPluginInstallMatchesSpec(
	install: z.infer<typeof openClawPluginInspectSchema>["install"],
	spec: string,
): boolean {
	const recordedSpecs = [install.spec, install.resolvedSpec];
	if (install.source === "clawhub" && install.clawhubPackage) {
		recordedSpecs.push(`clawhub:${install.clawhubPackage}`);
	}
	return recordedSpecs.includes(spec);
}
export const OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS: Record<string, readonly string[]> = {
	discord: ["@openclaw/discord"],
	whatsapp: ["clawhub:@openclaw/whatsapp"],
};
const OPENCLAW_MANAGED_CHANNELS = ["telegram", "discord", "whatsapp"] as const;
