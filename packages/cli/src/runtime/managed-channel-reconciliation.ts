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
	return {
		...(telegramEnabled ? { telegram: { enabled: true } } : {}),
		...(discordEnabled ? { discord: { enabled: true } } : {}),
		...(whatsappEnabled
			? {
					whatsapp: { enabled: true },
					platforms: {
						whatsapp: { enabled: true, extra: { session_path: whatsappAuthDir } },
					},
				}
			: {}),
	};
}

export function managedChannelHasAccounts(channel: unknown): boolean {
	const record = recordValue(channel);
	const accounts = recordValue(record?.accounts);
	return accounts !== null && Object.keys(accounts).length > 0;
}
