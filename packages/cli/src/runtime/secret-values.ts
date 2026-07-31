import { z } from "zod";

const SECRET_REF_PREFIX = "secret://";
const SECRET_REF_PATTERN = /^secret:\/\/\S+$/;

export const canonicalSecretRefSchema = z
	.string()
	.regex(SECRET_REF_PATTERN, "must be a canonical non-empty secret:// reference");

export function normalizeSecretValues(
	secretValues: Record<string, string> | undefined,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [ref, value] of Object.entries(secretValues ?? {})) {
		if (canonicalSecretRefName(ref) === null) {
			throw new Error(`runtime secret value key must be a canonical secret:// reference: ${ref}`);
		}
		if (!value) throw new Error(`runtime secret value must be non-empty: ${ref}`);
		normalized[ref] = value;
	}
	return normalized;
}

export function canonicalSecretRefName(ref: string | null | undefined): string | null {
	if (!ref || !SECRET_REF_PATTERN.test(ref)) return null;
	const name = ref.slice(SECRET_REF_PREFIX.length);
	return name;
}

export function runtimeSecretValue(secrets: Record<string, unknown>, ref: string): string | null {
	if (canonicalSecretRefName(ref) === null) return null;
	const value = secrets[ref];
	return typeof value === "string" && value.length > 0 ? value : null;
}
