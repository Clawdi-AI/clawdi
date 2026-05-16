export const MAX_SKILL_KEY_LEN = 200;

const SKILL_KEY_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}){0,3}$/;
const RESERVED_SUFFIXES = new Set(["download", "content", "install"]);

export function hasReservedSkillKeySuffix(skillKey: string): boolean {
	const parts = skillKey.split("/");
	return parts.length > 1 && RESERVED_SUFFIXES.has(parts[parts.length - 1] ?? "");
}

export function isValidSkillKey(skillKey: string): boolean {
	return (
		skillKey.length <= MAX_SKILL_KEY_LEN &&
		SKILL_KEY_PATTERN.test(skillKey) &&
		!hasReservedSkillKeySuffix(skillKey)
	);
}

export function assertValidSkillKey(skillKey: string): void {
	if (!isValidSkillKey(skillKey)) {
		throw new Error(`Invalid skill_key from server: ${JSON.stringify(skillKey)}`);
	}
}
