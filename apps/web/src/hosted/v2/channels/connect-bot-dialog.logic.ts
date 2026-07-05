const DISCORD_PUBLIC_KEY_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

export function discordPublicKeyError(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length !== DISCORD_PUBLIC_KEY_HEX_LENGTH || !HEX_PATTERN.test(trimmed)) {
		return "Enter a 64-character hex public key.";
	}
	return null;
}
