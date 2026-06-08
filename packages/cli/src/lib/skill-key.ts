import {
	MAX_SKILL_KEY_LEN,
	RESERVED_SKILL_KEY_SUFFIXES,
	SKILL_KEY_PATTERN,
} from "@clawdi/shared/consts";

const SKILL_KEY_RE = new RegExp(SKILL_KEY_PATTERN);
const RESERVED_SUFFIXES = new Set<string>(RESERVED_SKILL_KEY_SUFFIXES);

function hasReservedSkillKeySuffix(skillKey: string): boolean {
	const parts = skillKey.split("/");
	return parts.length > 1 && RESERVED_SUFFIXES.has(parts[parts.length - 1] ?? "");
}

export function isValidSkillKey(skillKey: string): boolean {
	return (
		skillKey.length <= MAX_SKILL_KEY_LEN &&
		SKILL_KEY_RE.test(skillKey) &&
		!hasReservedSkillKeySuffix(skillKey)
	);
}

export function assertValidSkillKey(skillKey: string): void {
	if (!isValidSkillKey(skillKey)) {
		throw new Error(`Invalid skill_key: ${JSON.stringify(skillKey)}`);
	}
}

/**
 * Turn an arbitrary local file/directory name into a backend-valid skill_key.
 *
 * This is intentionally colocated with `isValidSkillKey` so generated keys and
 * accepted keys do not drift from the backend contract.
 */
export function sanitizeSkillKey(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9._]+/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
		.substring(0, MAX_SKILL_KEY_LEN);
	const skillKey = sanitized || "unnamed-skill";
	assertValidSkillKey(skillKey);
	return skillKey;
}
