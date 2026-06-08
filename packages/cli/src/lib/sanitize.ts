import { normalize, resolve, sep } from "node:path";

/**
 * Sanitize untrusted strings before terminal output.
 *
 * Strips ALL terminal escape sequences from a string, including:
 *   - CSI sequences  (ESC [ ... final_byte)    — cursor movement, screen clear, SGR colors
 *   - OSC sequences  (ESC ] ... BEL/ST)         — window title, hyperlinks
 *   - DCS / PM / APC (ESC P|^|_ ... ST)
 *   - Simple escapes (ESC followed by one char)
 *   - C1 control codes (0x80–0x9F)
 *   - Raw control characters (BEL, BS, etc.) except \t and \n
 *
 * Defends against CWE-150 (terminal escape injection) where untrusted data
 * (e.g. skill name/description from API) could rewrite the terminal.
 * Ported from vercel/skills `src/sanitize.ts`.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
const C1_RE = /[\x80-\x9f]/g;
// Strips all C0 control chars except \t (0x09) and \n (0x0a). Matches Vercel skills/src/sanitize.ts.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

/** Strip terminal escape sequences and dangerous control chars. */
export function stripTerminalEscapes(str: string): string {
	return str
		.replace(OSC_RE, "")
		.replace(DCS_PM_APC_RE, "")
		.replace(CSI_RE, "")
		.replace(SIMPLE_ESC_RE, "")
		.replace(C1_RE, "")
		.replace(CONTROL_RE, "");
}

/** Sanitize a metadata string (name/description) for safe single-line display. */
export function sanitizeMetadata(str: string): string {
	return stripTerminalEscapes(str)
		.replace(/[\r\n]+/g, " ")
		.trim();
}

/**
 * Truncate `str` to at most `n` Unicode codepoints.
 *
 * `String#slice` operates on UTF-16 code units and can cut between the
 * halves of an emoji's surrogate pair, leaving a lone surrogate that
 * isn't valid UTF-8 — PostgreSQL/asyncpg then rejects the row. Spreading
 * via `[...str]` iterates by codepoint so the cut always lands on a
 * valid boundary.
 */
export function safeTruncate(str: string, n: number): string {
	const codepoints = [...str];
	if (codepoints.length <= n) return str;
	return codepoints.slice(0, n).join("");
}

/**
 * Sanitize a subpath to prevent path traversal.
 * Throws if any segment is literally "..".
 */
export function sanitizeSubpath(subpath: string): string {
	const normalized = subpath.replace(/\\/g, "/");
	const segments = normalized.split("/");
	for (const segment of segments) {
		if (segment === "..") {
			throw new Error(
				`Unsafe subpath: "${subpath}" contains ".." segments. Subpaths must not escape the base.`,
			);
		}
	}
	return subpath;
}

/** Check whether a resolved subpath stays within basePath. */
export function isSubpathSafe(basePath: string, subpath: string): boolean {
	const normalizedBase = normalize(resolve(basePath));
	const normalizedTarget = normalize(resolve(basePath, subpath));
	return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep);
}
