export const WHATSAPP_LINKING_READY = false;

export const CONNECTABLE_BOT_PROVIDERS = ["telegram", "discord", "whatsapp"] as const;
export type ConnectableBotProvider = (typeof CONNECTABLE_BOT_PROVIDERS)[number];

const SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
	hermes: new Set(["telegram", "discord", "whatsapp"]),
	openclaw: new Set(["telegram", "discord", "whatsapp"]),
};

export function channelProviderLinkingReady(provider: string): boolean {
	return provider !== "whatsapp" || WHATSAPP_LINKING_READY;
}

export function agentProviderHasSingleLinkLimit(
	agentType: string | null | undefined,
	provider: string,
): boolean {
	return Boolean(agentType && SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE[agentType]?.has(provider));
}

export function agentProviderLinkReplacementRequired(
	agentType: string | null | undefined,
	provider: string,
	linkedProviders: ReadonlySet<string> | null | undefined,
	linkingReady = channelProviderLinkingReady(provider),
): boolean {
	return Boolean(
		linkingReady &&
			agentProviderHasSingleLinkLimit(agentType, provider) &&
			linkedProviders?.has(provider),
	);
}

export function agentProviderLinkStatusUnknown(
	agentType: string | null | undefined,
	provider: string,
	linkedProviders: ReadonlySet<string> | null | undefined,
	linkingReady = channelProviderLinkingReady(provider),
): boolean {
	return Boolean(
		linkingReady && agentProviderHasSingleLinkLimit(agentType, provider) && !linkedProviders,
	);
}

/**
 * Return the Agent id only when creating this bot can safely preserve the
 * hosted runtime's provider cardinality. A null value is sent explicitly so
 * the API adds the bot to inventory without selecting or linking an Agent.
 */
export function autoLinkAgentIdForNewCustomBot(
	agentId: string | null | undefined,
	agentType: string | null | undefined,
	provider: string,
	linkedProviders: ReadonlySet<string> | null | undefined,
): string | null {
	if (!agentId || !channelProviderLinkingReady(provider)) return null;
	if (
		agentProviderHasSingleLinkLimit(agentType, provider) &&
		(!linkedProviders || linkedProviders.has(provider))
	) {
		return null;
	}
	return agentId;
}

export function pairingCommand(code: string): string {
	return `/clawdi_pair ${code}`;
}

export function verifiedDiscordPairingCommand(pairingCommand: string, code: string): string | null {
	const expected = `/clawdi_pair ${code}`;
	return pairingCommand === expected ? pairingCommand : null;
}

const DISCORD_INSTALL_URL_MAX_LENGTH = 8_192;
const DISCORD_INSTALL_QUERY_MAX_ENTRIES = 16;
const DISCORD_INSTALL_QUERY_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const DISCORD_INSTALL_QUERY_VALUE_MAX_LENGTH = 2_048;
const DISCORD_INSTALL_REDIRECT_KEYS = new Set(["redirect_uri", "response_type"]);

function hasAsciiControlCharacters(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

/**
 * Keep external navigation on Discord without duplicating Discord install policy.
 * The backend owns installation contexts, scopes, and role permissions.
 */
export function verifiedDiscordInstallUrl(value: string | null | undefined): string | null {
	if (!value || value.length > DISCORD_INSTALL_URL_MAX_LENGTH) return null;
	try {
		const url = new URL(value);
		const entries = [...url.searchParams.entries()];
		const clientId = url.searchParams.get("client_id");
		if (
			url.origin !== "https://discord.com" ||
			url.pathname !== "/oauth2/authorize" ||
			url.username ||
			url.password ||
			url.hash ||
			!clientId ||
			!/^[0-9]{17,20}$/.test(clientId) ||
			url.searchParams.getAll("client_id").length !== 1 ||
			entries.length > DISCORD_INSTALL_QUERY_MAX_ENTRIES
		) {
			return null;
		}

		try {
			decodeURIComponent(url.search.replaceAll("+", "%20"));
		} catch {
			return null;
		}

		const seenKeys = new Set<string>();
		for (const [key, queryValue] of entries) {
			if (
				seenKeys.has(key) ||
				!DISCORD_INSTALL_QUERY_KEY.test(key) ||
				DISCORD_INSTALL_REDIRECT_KEYS.has(key) ||
				!queryValue ||
				queryValue.length > DISCORD_INSTALL_QUERY_VALUE_MAX_LENGTH ||
				hasAsciiControlCharacters(queryValue)
			) {
				return null;
			}
			seenKeys.add(key);
		}

		// Render the canonical serialization of the same URL object that passed
		// validation, so casing, default ports, dot segments, or surrounding
		// whitespace cannot make validation and navigation parse different values.
		return url.href;
	} catch {
		return null;
	}
}

export function pairCodeExpired(expiresAt: string, nowMs: number): boolean {
	const expiresAtMs = Date.parse(expiresAt);
	return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}
