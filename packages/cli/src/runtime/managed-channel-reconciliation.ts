import { resolve } from "node:path";
import { z } from "zod";
import type { RuntimeManifest } from "./manifest-contract";
import { managedWhatsAppAuthCredentials } from "./whatsapp-credential-projection";

const uuidSchema = z.string().uuid();

export function managedHermesWhatsAppAuthDir(
	manifest: RuntimeManifest,
	home: string,
): string | null {
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
	uuidSchema.parse(credential.linkId);
	uuidSchema.parse(credential.credentialId);
	const authDir = resolve(credential.authDir);
	const expectedAuthDir = resolve(home, ".hermes", "platforms", "whatsapp", "session");
	if (authDir !== expectedAuthDir) {
		throw new Error(`managed Hermes WhatsApp auth directory must be ${expectedAuthDir}`);
	}
	return authDir;
}

export function buildHermesManagedChannelsPatch(
	channels: Record<string, unknown>,
	whatsappAuthDir: string | null,
): Record<string, unknown> {
	const telegramEnabled = managedChannelHasAccounts(channels.telegram);
	const discordEnabled = managedChannelHasAccounts(channels.discord);
	const whatsappEnabled = managedChannelHasAccounts(channels.whatsapp);
	if (whatsappEnabled && !whatsappAuthDir) {
		throw new Error("managed Hermes WhatsApp projection is missing its exact auth directory");
	}
	const whatsapp = whatsappEnabled
		? {
				enabled: true,
				dm_policy: "allowlist",
				group_policy: "open",
				allow_from: ["*"],
				group_allow_from: ["*"],
			}
		: {
				enabled: false,
				dm_policy: null,
				group_policy: null,
				allow_from: null,
				group_allow_from: null,
			};
	const whatsappPlatform = whatsappEnabled
		? {
				enabled: true,
				extra: {
					session_path: whatsappAuthDir,
					dm_policy: "allowlist",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					group_sessions_per_user: false,
					thread_sessions_per_user: false,
				},
			}
		: {
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
			};
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
		whatsapp,
		group_sessions_per_user: sharedChannelSessionsEnabled ? false : null,
		thread_sessions_per_user: sharedChannelSessionsEnabled ? false : null,
		platforms: {
			telegram: {
				extra: {
					group_sessions_per_user: telegramEnabled ? false : null,
					thread_sessions_per_user: telegramEnabled ? false : null,
				},
			},
			whatsapp: whatsappPlatform,
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

function plainRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
