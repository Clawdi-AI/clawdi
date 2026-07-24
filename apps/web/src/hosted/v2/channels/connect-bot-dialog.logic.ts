const DISCORD_PUBLIC_KEY_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MAX_UINT64_DECIMAL = "18446744073709551615";
const DISCORD_TOKEN_PATTERN = /^[A-Za-z0-9._-]{50,}$/;

function isDiscordSnowflake(value: string): boolean {
	return (
		DISCORD_SNOWFLAKE_PATTERN.test(value) &&
		(value.length < MAX_UINT64_DECIMAL.length || value <= MAX_UINT64_DECIMAL)
	);
}

export function discordBotTokenError(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	// Discord documents bot tokens as opaque credentials. Keep this deliberately
	// loose: reject only obviously truncated or non-token input without depending
	// on undocumented segment lengths that Discord may change.
	const valid = trimmed === value && DISCORD_TOKEN_PATTERN.test(trimmed);
	return valid ? null : "Enter a valid Discord bot token.";
}

export function discordApplicationIdError(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return isDiscordSnowflake(trimmed) ? null : "Enter a valid numeric application ID.";
}

export function discordGuildIdError(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return isDiscordSnowflake(trimmed) ? null : "Enter a valid numeric guild ID.";
}

export function discordPublicKeyError(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length !== DISCORD_PUBLIC_KEY_HEX_LENGTH || !HEX_PATTERN.test(trimmed)) {
		return "Enter a 64-character hex public key.";
	}
	return null;
}
