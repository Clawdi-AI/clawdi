import type { components } from "./api.generated";

type SearchableTool = Pick<
	components["schemas"]["ConnectorToolResponse"],
	"display_name" | "description"
>;

/** Web's connector tool search: literal, case-insensitive match on the visible name or description. */
export function filterConnectorTools<T extends SearchableTool>(tools: T[], search: string): T[] {
	if (!search.trim()) return tools;
	const q = search.trim().toLowerCase();
	return tools.filter(
		(t) => t.display_name?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
	);
}

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

export function isActiveConnection(c: { status: string; is_disabled?: boolean }): boolean {
	return c.status.trim().toUpperCase() === "ACTIVE" && !c.is_disabled;
}

export function connectorMetadataBatches(names: readonly string[]): string[][] {
	const unique = [...new Set(names.filter(Boolean))];
	const batches: string[][] = [];
	for (let offset = 0; offset < unique.length; offset += 100)
		batches.push(unique.slice(offset, offset + 100));
	return batches;
}

type AuthField = components["schemas"]["ConnectorAuthFieldResponse"];
export type CredentialField = Pick<AuthField, "name" | "default"> &
	Partial<Pick<AuthField, "required">> & { expected_from_customer?: boolean | null };

function hasDefaultValue(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function shouldShowCredentialField(field: CredentialField): boolean {
	if (field.expected_from_customer !== false) return true;
	if (!field.required) return false;
	return !hasDefaultValue(field.default);
}

export function getVisibleCredentialFields<T extends CredentialField>(fields: T[]): T[] {
	return fields.filter(shouldShowCredentialField);
}

export function buildCredentialPayload(
	fields: CredentialField[],
	values: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		fields.flatMap((field) => {
			const value = Object.hasOwn(values, field.name) ? values[field.name]?.trim() : undefined;
			if (value) return [[field.name, value]];
			if (!shouldShowCredentialField(field) && hasDefaultValue(field.default))
				return [[field.name, field.default.trim()]];
			return [];
		}),
	);
}
