import { normalizeSecretRef } from "./hosted-egress-profiles";

const ENV_SECRET_REF_PREFIX = "env://";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ProcessRuntimeEnvironment {
	kind: "process-environment";
	values: Readonly<Record<string, string | undefined>>;
}

export interface ProjectedRuntimeEnvironment {
	kind: "projected-environment";
	values: Readonly<Record<string, string>>;
}

export type RuntimeEnvironmentAuthority = ProcessRuntimeEnvironment | ProjectedRuntimeEnvironment;

export function processRuntimeEnvironment(
	values: Readonly<Record<string, string | undefined>> = process.env,
): ProcessRuntimeEnvironment {
	return { kind: "process-environment", values };
}

export function projectedRuntimeEnvironment(
	values: Readonly<Record<string, string>>,
): ProjectedRuntimeEnvironment {
	return { kind: "projected-environment", values: { ...values } };
}

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
	const canonicalValues = new Map<string, string>();
	for (const [ref, value] of Object.entries(secretValues ?? {})) {
		if (isEnvSecretRef(ref)) continue;
		const secretRef = normalizeSecretRef(ref);
		if (!secretRef) continue;
		const existing = canonicalValues.get(secretRef);
		if (existing !== undefined && existing !== value) {
			throw new Error(`conflicting secret values for ${secretRef}`);
		}
		canonicalValues.set(secretRef, value);
	}

	const normalized: Record<string, string> = {};
	for (const [ref, value] of Object.entries(secretValues ?? {})) {
		normalized[ref] = value;
	}
	for (const [secretRef, value] of canonicalValues) {
		normalized[secretRef] = value;
	}
	return normalized;
}

export function canonicalSecretRefName(ref: string | null | undefined): string | null {
	const normalized = normalizeSecretRef(ref ?? undefined);
	return normalized?.startsWith("secret://") ? normalized.slice("secret://".length) : null;
}

export function runtimeSecretValue(
	secrets: Record<string, unknown>,
	ref: string,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string | null {
	const envName = envSecretRefName(ref);
	if (envName) {
		const value = runtimeEnvironment.values[envName]?.trim();
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
