export const MAX_SKILL_KEY_LEN = 200;

export const SKILL_KEY_PATTERN =
	"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(/[A-Za-z0-9][A-Za-z0-9._-]{0,199}){0,3}$";

export const RESERVED_SKILL_KEY_SUFFIXES = ["download", "content", "install"] as const;
