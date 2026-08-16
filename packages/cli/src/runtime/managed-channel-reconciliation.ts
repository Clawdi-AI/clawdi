import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RuntimeApplyContext } from "./apply-identity";
import type { RuntimeManifest } from "./manifest-contract";
import { loadCommittedRuntimeManifest } from "./manifest-source";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";
import { managedWhatsAppAuthCredentials } from "./whatsapp-credential-projection";

const RECEIPT_FILE = "hermes-whatsapp.json";
const receiptSchema = z
	.object({
		schemaVersion: z.literal("clawdi.managedHermesWhatsApp.v1"),
		deploymentId: z.string().min(1),
		environmentId: z.string().min(1),
		instanceId: z.string().min(1),
		runtime: z.literal("hermes"),
		provider: z.literal("whatsapp"),
		accountKey: z.string().min(1),
		linkId: z.string().uuid(),
		credentialId: z.string().uuid(),
		authDir: z.string().min(1),
	})
	.strict()
	.refine((receipt) => resolve(receipt.authDir) === receipt.authDir, {
		message: "managed Hermes WhatsApp auth directory must be absolute",
		path: ["authDir"],
	});

export type ManagedHermesWhatsAppReceipt = z.infer<typeof receiptSchema>;

export interface ManagedHermesWhatsAppPlan {
	previous: ManagedHermesWhatsAppReceipt | null;
	desired: ManagedHermesWhatsAppReceipt | null;
	cleanupAuthorized: boolean;
	commit: boolean;
}

export function managedHermesWhatsAppReceiptPath(paths: RuntimePaths): string {
	return join(paths.managedResourceRoot, RECEIPT_FILE);
}

export function planManagedHermesWhatsApp(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	applyContext: RuntimeApplyContext;
	home: string;
}): ManagedHermesWhatsAppPlan {
	const desired = desiredHermesWhatsAppReceipt(input.manifest, input.home);
	const stored = readManagedHermesWhatsAppReceipt(input.paths);
	if (stored) assertReceiptAuthority(stored, input.manifest, input.home);
	const commit =
		input.manifest.runtimes.hermes?.enabled === true &&
		input.manifest.projection !== undefined &&
		Object.hasOwn(input.manifest.projection, "channels");
	const previous =
		stored ??
		(desired === null && commit
			? recoverCommittedHermesWhatsAppReceipt(
					input.manifest,
					input.paths,
					input.applyContext,
					input.home,
				)
			: null);
	return {
		previous,
		desired,
		cleanupAuthorized: commit && desired === null && previous !== null,
		commit,
	};
}

export function buildHermesManagedChannelsPatch(
	channels: Record<string, unknown>,
	plan: ManagedHermesWhatsAppPlan,
	currentConfig: string,
): Record<string, unknown> {
	return hermesManagedChannelsPatch(
		channels,
		plan.desired,
		hermesWhatsAppConfigCleanupAuthorized(plan, currentConfig),
	);
}

export function buildHermesManagedChannelsRevision(
	channels: Record<string, unknown>,
	plan: ManagedHermesWhatsAppPlan,
): Record<string, unknown> {
	return hermesManagedChannelsPatch(channels, plan.desired, false);
}

function hermesManagedChannelsPatch(
	channels: Record<string, unknown>,
	desiredWhatsApp: ManagedHermesWhatsAppReceipt | null,
	cleanupWhatsApp: boolean,
): Record<string, unknown> {
	const telegramEnabled = managedChannelHasAccounts(channels.telegram);
	const discordEnabled = managedChannelHasAccounts(channels.discord);
	const whatsappEnabled = managedChannelHasAccounts(channels.whatsapp);
	if (whatsappEnabled && !desiredWhatsApp) {
		throw new Error("managed Hermes WhatsApp projection is missing its exact ownership identity");
	}
	const whatsapp = whatsappEnabled
		? {
				enabled: true,
				dm_policy: "allowlist",
				group_policy: "open",
				allow_from: ["*"],
				group_allow_from: ["*"],
			}
		: cleanupWhatsApp
			? {
					enabled: false,
					dm_policy: null,
					group_policy: null,
					allow_from: null,
					group_allow_from: null,
				}
			: null;
	const whatsappPlatform = whatsappEnabled
		? {
				enabled: true,
				extra: {
					session_path: desiredWhatsApp?.authDir,
					dm_policy: "allowlist",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					group_sessions_per_user: false,
					thread_sessions_per_user: false,
				},
			}
		: cleanupWhatsApp
			? {
					enabled: false,
					extra: {
						session_path: null,
						dm_policy: null,
						group_policy: null,
						allow_from: null,
						group_allow_from: null,
						group_sessions_per_user: null,
						thread_sessions_per_user: null,
					},
				}
			: null;
	const sharedChannelSessionsEnabled = telegramEnabled || discordEnabled || whatsappEnabled;
	return {
		telegram: telegramEnabled
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					group_allowed_chats: ["*"],
					require_mention: false,
					extra: {
						base_url: "https://api.telegram.org/bot",
						base_file_url: "https://api.telegram.org/file/bot",
					},
				}
			: { enabled: false },
		discord: discordEnabled
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					require_mention: false,
					thread_require_mention: false,
					bots_require_inline_mention: false,
				}
			: { enabled: false },
		...(whatsapp ? { whatsapp } : {}),
		group_sessions_per_user: sharedChannelSessionsEnabled ? false : null,
		thread_sessions_per_user: sharedChannelSessionsEnabled ? false : null,
		platforms: {
			telegram: {
				extra: {
					group_sessions_per_user: telegramEnabled ? false : null,
					thread_sessions_per_user: telegramEnabled ? false : null,
				},
			},
			...(whatsappPlatform ? { whatsapp: whatsappPlatform } : {}),
		},
		display: {
			platforms: {
				telegram: {
					streaming: telegramEnabled ? true : null,
				},
			},
		},
	};
}

export function managedChannelHasAccounts(channel: unknown): boolean {
	const record = plainRecord(channel);
	const accounts = plainRecord(record?.accounts);
	return accounts !== null && Object.keys(accounts).length > 0;
}

export function commitManagedHermesWhatsApp(
	plan: ManagedHermesWhatsAppPlan,
	paths: RuntimePaths,
): void {
	if (!plan.commit) return;
	const path = managedHermesWhatsAppReceiptPath(paths);
	if (!plan.desired) {
		rmSync(path, { force: true });
		return;
	}
	writeRuntimePlatformFileAtomic(paths, path, `${JSON.stringify(plan.desired, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o755,
	});
	const persisted = readManagedHermesWhatsAppReceipt(paths);
	if (!persisted || JSON.stringify(persisted) !== JSON.stringify(plan.desired)) {
		throw new Error("managed Hermes WhatsApp receipt did not pass post-write verification");
	}
}

function desiredHermesWhatsAppReceipt(
	manifest: RuntimeManifest,
	home: string,
): ManagedHermesWhatsAppReceipt | null {
	if (manifest.runtimes.hermes?.enabled !== true) return null;
	const channels = plainRecord(manifest.projection?.channels);
	const whatsapp = plainRecord(channels?.whatsapp);
	const accounts = plainRecord(whatsapp?.accounts);
	if (!accounts || Object.keys(accounts).length === 0) return null;
	const accountKeys = Object.keys(accounts).sort();
	if (accountKeys.length !== 1) {
		throw new Error("managed Hermes WhatsApp projection must contain exactly one account");
	}
	const [accountKey] = accountKeys;
	if (!accountKey) throw new Error("managed Hermes WhatsApp account identity is missing");
	const credentials = managedWhatsAppAuthCredentials(
		manifest.projection?.channelCredentials,
	).filter((credential) => credential.target === "hermes" && credential.accountKey === accountKey);
	if (credentials.length !== 1) {
		throw new Error("managed Hermes WhatsApp projection must contain one exact credential");
	}
	const credential = credentials[0];
	if (!credential?.linkId) {
		throw new Error("managed Hermes WhatsApp projection is missing its Link identity");
	}
	const authDir = resolve(credential.authDir);
	const expectedAuthDir = managedHermesWhatsAppAuthDir(home);
	if (authDir !== expectedAuthDir) {
		throw new Error(`managed Hermes WhatsApp auth directory must be ${expectedAuthDir}`);
	}
	return receiptSchema.parse({
		schemaVersion: "clawdi.managedHermesWhatsApp.v1",
		deploymentId: manifest.deploymentId,
		environmentId: manifest.environmentId,
		instanceId: manifest.instanceId,
		runtime: "hermes",
		provider: "whatsapp",
		accountKey,
		linkId: credential.linkId,
		credentialId: credential.credentialId,
		authDir,
	});
}

function recoverCommittedHermesWhatsAppReceipt(
	current: RuntimeManifest,
	paths: RuntimePaths,
	applyContext: RuntimeApplyContext,
	home: string,
): ManagedHermesWhatsAppReceipt | null {
	const committed = loadCommittedRuntimeManifest(paths, applyContext);
	if (!("manifest" in committed)) return null;
	if (
		committed.manifest.deploymentId !== current.deploymentId ||
		committed.manifest.environmentId !== current.environmentId ||
		committed.manifest.instanceId !== current.instanceId
	) {
		throw new Error("committed Hermes WhatsApp ownership belongs to another runtime identity");
	}
	return desiredHermesWhatsAppReceipt(committed.manifest, home);
}

function readManagedHermesWhatsAppReceipt(
	paths: RuntimePaths,
): ManagedHermesWhatsAppReceipt | null {
	const path = managedHermesWhatsAppReceiptPath(paths);
	if (!existsSync(path)) return null;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
		if ((stat.mode & 0o777) !== 0o600) throw new Error("permissions are not private");
		if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
			throw new Error("owner is unexpected");
		}
		return receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch (error) {
		throw new Error(
			`managed Hermes WhatsApp receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function assertReceiptAuthority(
	receipt: ManagedHermesWhatsAppReceipt,
	manifest: RuntimeManifest,
	home: string,
): void {
	if (
		receipt.deploymentId !== manifest.deploymentId ||
		receipt.environmentId !== manifest.environmentId ||
		receipt.instanceId !== manifest.instanceId
	) {
		throw new Error("managed Hermes WhatsApp receipt belongs to another runtime identity");
	}
	const expectedAuthDir = managedHermesWhatsAppAuthDir(home);
	if (receipt.authDir !== expectedAuthDir) {
		throw new Error(`managed Hermes WhatsApp receipt auth directory must be ${expectedAuthDir}`);
	}
}

function managedHermesWhatsAppAuthDir(home: string): string {
	return resolve(home, ".hermes", "platforms", "whatsapp", "session");
}

function hermesWhatsAppConfigCleanupAuthorized(
	plan: ManagedHermesWhatsAppPlan,
	content: string,
): boolean {
	if (!plan.cleanupAuthorized || !plan.previous) return false;
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (error) {
		throw new Error(
			`Hermes config is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const root = plainRecord(parsed);
	const platforms = plainRecord(root?.platforms);
	const whatsapp = plainRecord(platforms?.whatsapp);
	const extra = plainRecord(whatsapp?.extra);
	const sessionPath = extra?.session_path;
	if (sessionPath !== undefined && sessionPath !== null && sessionPath !== plan.previous.authDir) {
		throw new Error("refusing to remove user-owned Hermes WhatsApp session configuration");
	}
	return true;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
