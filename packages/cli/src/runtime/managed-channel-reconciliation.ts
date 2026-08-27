import type { RuntimeManifest } from "./manifest-contract";
import { recordValue } from "./manifest-shared";
import { managedWhatsAppAuthDir } from "./whatsapp-credential-projection";

export function managedHermesWhatsAppAuthDir(
	manifest: RuntimeManifest,
	home: string,
): string | null {
	if (manifest.runtimes.hermes?.enabled !== true) return null;
	const channels = recordValue(manifest.projection?.channels);
	if (!managedChannelHasAccounts(channels?.whatsapp)) return null;
	return managedWhatsAppAuthDir(home, "hermes", "");
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
			: {
					enabled: false,
					dm_policy: null,
					group_policy: null,
					allow_from: null,
					group_allow_from: null,
					group_allowed_chats: null,
					require_mention: null,
					extra: {
						base_url: null,
						base_file_url: null,
					},
				},
		discord: discordEnabled
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					require_mention: false,
					thread_require_mention: false,
					bots_require_inline_mention: false,
				}
			: {
					enabled: false,
					dm_policy: null,
					group_policy: null,
					require_mention: null,
					thread_require_mention: null,
					bots_require_inline_mention: null,
				},
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
	const record = recordValue(channel);
	const accounts = recordValue(record?.accounts);
	return accounts !== null && Object.keys(accounts).length > 0;
}
