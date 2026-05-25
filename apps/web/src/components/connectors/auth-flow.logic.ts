const REDIRECT_AUTH_TYPES = new Set(["oauth", "oauth1", "oauth2", "dcr_oauth", "composio_link"]);
const CREDENTIAL_AUTH_TYPES = new Set(["api_key", "bearer_token", "basic"]);
const NO_AUTH_TYPES = new Set(["none", "no_auth"]);

export type ConnectorAuthFlow = "credentials" | "no_auth" | "redirect";

export function getConnectorAuthFlow(
	authType: string | null | undefined,
): ConnectorAuthFlow | null {
	const normalized = (authType ?? "").trim().toLowerCase();
	if (NO_AUTH_TYPES.has(normalized)) return "no_auth";
	if (REDIRECT_AUTH_TYPES.has(normalized)) return "redirect";
	if (CREDENTIAL_AUTH_TYPES.has(normalized)) return "credentials";
	return null;
}
