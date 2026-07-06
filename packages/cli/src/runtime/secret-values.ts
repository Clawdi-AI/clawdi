import { normalizeSecretRef } from "./hosted-mitm-profiles";

const ENV_SECRET_REF_PREFIX = "env://";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function envSecretRefName(ref: string): string | null {
	if (!ref.startsWith(ENV_SECRET_REF_PREFIX)) return null;
	const envName = ref.slice(ENV_SECRET_REF_PREFIX.length);
	return ENV_KEY_RE.test(envName) ? envName : null;
}

export function isEnvSecretRef(ref: string): boolean {
	return envSecretRefName(ref) !== null;
}

export function normalizeSecretValues(
	secretValues: Record<string, string> | undefined,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [ref, value] of Object.entries(secretValues ?? {})) {
		normalized[ref] = value;
		const secretRef = normalizeSecretRef(ref);
		if (secretRef && normalized[secretRef] === undefined) {
			normalized[secretRef] = value;
		}
	}
	return normalized;
}

export function runtimeSecretValue(secrets: Record<string, unknown>, ref: string): string | null {
	const envName = envSecretRefName(ref);
	if (envName) {
		const value = process.env[envName]?.trim();
		return value ? value : null;
	}
	const normalized = normalizeSecretRef(ref);
	const raw = ref.startsWith("secret://") ? ref.slice("secret://".length) : null;
	const candidates = [ref, normalized, raw].filter(
		(candidate, index, values): candidate is string =>
			Boolean(candidate) && values.indexOf(candidate) === index,
	);
	for (const candidate of candidates) {
		const value = secrets[candidate];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}
