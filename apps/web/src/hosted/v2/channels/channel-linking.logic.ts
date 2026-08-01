export const WHATSAPP_LINKING_READY = false;

export const CONNECTABLE_BOT_PROVIDERS = ["telegram", "discord"] as const;
export type ConnectableBotProvider = (typeof CONNECTABLE_BOT_PROVIDERS)[number];

const SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
	hermes: new Set(["telegram", "discord"]),
	openclaw: new Set(["telegram", "discord"]),
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

export function availableBotProvidersForAgent(
	agentId: string | null | undefined,
	agentType: string | null | undefined,
	linkedProviders: ReadonlySet<string> | null | undefined,
): ConnectableBotProvider[] {
	return CONNECTABLE_BOT_PROVIDERS.filter(
		(provider) =>
			!agentId ||
			!agentProviderHasSingleLinkLimit(agentType, provider) ||
			!linkedProviders?.has(provider),
	);
}

export function pairingCommand(code: string): string {
	return `/bot_pair ${code}`;
}

export function verifiedDiscordPairingCommand(pairingCommand: string, code: string): string | null {
	const expected = `/clawdi_pair ${code}`;
	return pairingCommand === expected ? pairingCommand : null;
}

export function verifiedDiscordServerInstallUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		const clientId = url.searchParams.get("client_id");
		const scopes = new Set((url.searchParams.get("scope") ?? "").split(" "));
		if (
			url.origin !== "https://discord.com" ||
			url.pathname !== "/oauth2/authorize" ||
			url.username ||
			url.password ||
			url.hash ||
			!clientId ||
			!/^[0-9]{17,20}$/.test(clientId) ||
			url.searchParams.getAll("client_id").length !== 1 ||
			url.searchParams.get("integration_type") !== "0" ||
			url.searchParams.getAll("integration_type").length !== 1 ||
			url.searchParams.get("permissions") !== "274878024768" ||
			url.searchParams.getAll("permissions").length !== 1 ||
			url.searchParams.getAll("scope").length !== 1 ||
			scopes.size !== 2 ||
			!scopes.has("applications.commands") ||
			!scopes.has("bot")
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

export function verifiedDiscordUserInstallUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
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
			url.searchParams.get("integration_type") !== "1" ||
			url.searchParams.getAll("integration_type").length !== 1 ||
			url.searchParams.get("scope") !== "applications.commands" ||
			url.searchParams.getAll("scope").length !== 1 ||
			url.searchParams.has("permissions")
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

export function pairingActionLabel(provider: string): string {
	return provider === "discord" ? "Pair Discord" : "Pair chat";
}

export function pairCodeExpired(expiresAt: string, nowMs: number): boolean {
	const expiresAtMs = Date.parse(expiresAt);
	return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}
