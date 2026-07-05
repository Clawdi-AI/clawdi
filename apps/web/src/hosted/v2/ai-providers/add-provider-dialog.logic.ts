import type { AiProviderAuth } from "@/hosted/v2/ai-providers/types";

export type AuthMethod = "api_key" | "oauth" | "none";

export type ApiKeyKeepKind = "managed" | "env" | "vault" | "legacy_secret_ref";

export interface ApiKeyEditState {
	canKeepManagedApiKey: boolean;
	canKeepLegacySecretRef: boolean;
	canKeepExternalApiKeyRef: boolean;
	canKeepExistingKey: boolean;
	keyRequired: boolean;
	labelSuffix: string;
	helpText: string;
}

export function isAuthMethod(value: string | null): value is AuthMethod {
	return value === "api_key" || value === "oauth" || value === "none";
}

export function authFor(method: AuthMethod): AiProviderAuth {
	if (method === "api_key") return { type: "api_key", source: "managed" };
	if (method === "oauth") return { type: "agent_profile", tool: "codex", profile: "default" };
	return { type: "none" };
}

export function apiKeyEditState(
	authMethod: AuthMethod,
	editingAuth: AiProviderAuth | null | undefined,
): ApiKeyEditState {
	const keepable = keepableExistingApiKeyAuth(editingAuth);
	const keepKind = authMethod === "api_key" ? keepable?.kind : undefined;
	const canKeepExistingKey = keepKind !== undefined;
	return {
		canKeepManagedApiKey: keepKind === "managed",
		canKeepLegacySecretRef: keepKind === "legacy_secret_ref",
		canKeepExternalApiKeyRef: keepKind === "env" || keepKind === "vault",
		canKeepExistingKey,
		keyRequired: authMethod === "api_key" && !canKeepExistingKey,
		labelSuffix: apiKeyLabelSuffix(keepKind),
		helpText: apiKeyHelpText(keepKind),
	};
}

export function providerAuthForSubmit({
	authMethod,
	editingAuth,
	hasNewManagedKey,
}: {
	authMethod: AuthMethod;
	editingAuth: AiProviderAuth | null | undefined;
	hasNewManagedKey: boolean;
}): AiProviderAuth {
	if (authMethod !== "api_key") return authFor(authMethod);
	if (!hasNewManagedKey) {
		const keepable = keepableExistingApiKeyAuth(editingAuth);
		if (keepable) return keepable.auth;
	}
	return authFor("api_key");
}

function keepableExistingApiKeyAuth(
	auth: AiProviderAuth | null | undefined,
): { kind: ApiKeyKeepKind; auth: AiProviderAuth } | null {
	if (!auth) return null;
	if (auth.type === "secret_ref" && auth.ref) return { kind: "legacy_secret_ref", auth };
	if (auth.type !== "api_key") return null;
	if (auth.source === "managed") return { kind: "managed", auth };
	if ((auth.source === "env" || auth.source === "vault") && auth.ref) {
		return { kind: auth.source, auth };
	}
	return null;
}

function apiKeyLabelSuffix(kind: ApiKeyKeepKind | undefined): string {
	if (!kind) return "";
	if (kind === "managed") return " (leave blank to keep)";
	if (kind === "legacy_secret_ref") return " (leave blank to keep legacy reference)";
	return ` (leave blank to keep current ${kind} reference)`;
}

function apiKeyHelpText(kind: ApiKeyKeepKind | undefined): string {
	if (kind === "legacy_secret_ref") {
		return "Leave blank to preserve this provider's existing legacy secret reference. Enter a key to switch it to managed API-key auth.";
	}
	if (kind === "env" || kind === "vault") {
		return `Leave blank to keep the current ${kind} reference. Enter a key to switch it to managed API-key auth.`;
	}
	if (kind === "managed") {
		return "Leave blank to keep the current managed key. Enter a key to replace it.";
	}
	return "Stored encrypted for the hosted runtime and delivered as a manifest secret. The dashboard will not show it again.";
}
