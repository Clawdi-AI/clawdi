import { createParser } from "nuqs";

/**
 * 1-indexed strict integer parser for URL-paginated lists. `Number()`
 * (unlike `parseInt`) rejects mixed input like "3junk", so a malformed
 * `?page=3junk` falls back to the parser default instead of silently
 * landing on page 3. Shared by every nuqs-paginated list (sessions,
 * connectors, memories, skills).
 */
export const parseAsPositiveInt = createParser({
	parse: (raw: string) => {
		const n = Number(raw);
		return Number.isInteger(n) && n >= 1 ? n : null;
	},
	serialize: (n: number) => String(n),
});
