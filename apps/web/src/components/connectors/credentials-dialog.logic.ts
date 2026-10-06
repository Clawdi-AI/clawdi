export type CredentialField = {
	name: string;
	required?: boolean;
	expected_from_customer?: boolean | null;
	default?: string | null;
};

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
	const payload: Record<string, string> = {};
	for (const field of fields) {
		const value = values[field.name]?.trim();
		if (value) {
			payload[field.name] = value;
			continue;
		}
		if (!shouldShowCredentialField(field) && hasDefaultValue(field.default)) {
			payload[field.name] = field.default.trim();
		}
	}
	return payload;
}
