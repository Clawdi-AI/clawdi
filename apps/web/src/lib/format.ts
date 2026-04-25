/**
 * Display formatters shared across the dashboard. Keep them here (not in
 * `utils.ts`) so the model-/time-specific patterns don't get tangled up
 * with the tiny `cn` / `errorMessage` helpers.
 */

const ANTHROPIC_FAMILIES = new Set(["opus", "sonnet", "haiku"]);

function titleCase(s: string): string {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Strip a trailing date suffix from a model id token list:
 *   ["opus","4","20250514"]  → ["opus","4"]
 *   ["opus","4","1","20251001"] → ["opus","4","1"]
 *   ["4o","2024","08","06"]  → ["4o"]
 * Matches both `YYYYMMDD` (single 6+digit token) and `YYYY-MM-DD` (three
 * trailing date-shaped tokens). */
function stripDateSuffix(tokens: string[]): string[] {
	if (tokens.length === 0) return tokens;
	if (/^\d{6,}$/.test(tokens[tokens.length - 1])) return tokens.slice(0, -1);
	if (
		tokens.length >= 3 &&
		/^\d{4}$/.test(tokens[tokens.length - 3]) &&
		/^\d{2}$/.test(tokens[tokens.length - 2]) &&
		/^\d{2}$/.test(tokens[tokens.length - 1])
	) {
		return tokens.slice(0, -3);
	}
	return tokens;
}

/**
 * Humanize an Anthropic / OpenAI model id for the UI.
 *
 *   claude-opus-4-7              → Opus 4.7
 *   claude-opus-4-1-20250105     → Opus 4.1
 *   claude-opus-4-20250514       → Opus 4
 *   claude-3-5-sonnet-20241022   → Sonnet 3.5
 *   claude-haiku-4-5             → Haiku 4.5
 *   gpt-5.4-codex                → GPT 5.4 Codex
 *   gpt-5.4-codex-preview        → GPT 5.4 Codex Preview
 *   gpt-4o-2024-08-06            → GPT 4o
 *   o3                           → O3
 *   o4-mini                      → O4 Mini
 *
 * Unknown shapes pass through unchanged so a new vendor doesn't render
 * as gibberish — better to show the raw id than a wrong name.
 *
 * Strategy: tokenize on `-`, drop trailing date-shaped tokens, then route
 * by prefix. The previous implementation used one regex per family and
 * fell over on the cases above (older `claude-3-5-sonnet-…`, single-major
 * `claude-opus-4-{date}`, GPT with date suffix, the entire o-series).
 */
export function formatModelLabel(modelId: string | null | undefined): string {
	if (!modelId) return "";
	const lower = modelId.trim().toLowerCase();
	if (!lower) return "";

	// --- Anthropic ---
	if (lower.startsWith("claude-")) {
		const tokens = stripDateSuffix(lower.slice("claude-".length).split("-"));
		const familyIdx = tokens.findIndex((t) => ANTHROPIC_FAMILIES.has(t));
		if (familyIdx === -1) return modelId;
		const family = titleCase(tokens[familyIdx]);
		const numbers = tokens.filter((t) => /^\d+$/.test(t));
		if (numbers.length >= 2) return `${family} ${numbers[0]}.${numbers[1]}`;
		if (numbers.length === 1) return `${family} ${numbers[0]}`;
		return family;
	}

	// --- OpenAI GPT --- accepts `gpt-N`, `gpt-N.M`, `gpt-No` (4o), `gpt-Noo`...
	if (lower.startsWith("gpt-")) {
		const tokens = stripDateSuffix(lower.slice("gpt-".length).split("-"));
		if (tokens.length === 0) return modelId;
		// Version is the first token; everything after is variant labels.
		const [version, ...variants] = tokens;
		const variantPart = variants.map(titleCase).join(" ");
		return variantPart ? `GPT ${version} ${variantPart}` : `GPT ${version}`;
	}

	// --- OpenAI o-series --- `o3`, `o4-mini`, `o3-pro`...
	if (/^o\d/.test(lower)) {
		const tokens = stripDateSuffix(lower.split("-"));
		const [base, ...variants] = tokens;
		const baseFormatted = base.toUpperCase();
		const variantPart = variants.map(titleCase).join(" ");
		return variantPart ? `${baseFormatted} ${variantPart}` : baseFormatted;
	}

	// Unknown shape — pass through.
	return modelId;
}

/**
 * Compact human-readable duration.
 *
 *   45      → "45s"
 *   180     → "3m"
 *   7200    → "2h 0m"
 *   null    → "—"
 */
export function formatDuration(seconds: number | null | undefined): string {
	if (!seconds) return "—";
	if (seconds < 60) return `${seconds}s`;
	const mins = Math.floor(seconds / 60);
	if (mins < 60) return `${mins}m`;
	return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
