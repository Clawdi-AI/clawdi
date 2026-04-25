/**
 * Display formatters shared across the dashboard. Keep them here (not in
 * `utils.ts`) so the model-/time-specific patterns don't get tangled up
 * with the tiny `cn` / `errorMessage` helpers.
 */

/**
 * Humanize an Anthropic / OpenAI model id for the UI.
 *
 * Accepts the raw id we get from the API (`claude-opus-4-7`,
 * `gpt-5.4-codex-preview`, etc.) and returns something a human reads as
 * a name, not a slug. Heuristics — not authoritative — but consistent
 * across the dashboard, which was the actual user complaint ("opus-4-7
 * 这个是原始的id吗").
 *
 *   claude-opus-4-7        → Opus 4.7
 *   claude-sonnet-4-6      → Sonnet 4.6
 *   claude-haiku-4-5-20251 → Haiku 4.5
 *   gpt-5.4-codex          → GPT 5.4 Codex
 *   gpt-5.3-codex-preview  → GPT 5.3 Codex (preview)
 *
 * Unknown shapes pass through unchanged so a new vendor doesn't render
 * as gibberish — better to show the raw id than the wrong name.
 */
export function formatModelLabel(modelId: string | null | undefined): string {
	if (!modelId) return "";
	const id = modelId.trim().toLowerCase();

	// Anthropic family — strip the `claude-` prefix, replace dashes with
	// dots in the version segment, capitalize the family name. Drop a
	// trailing date suffix (`claude-haiku-4-5-20251001` → `Haiku 4.5`)
	// since it's noise to non-API readers.
	const claudeMatch = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{6,})?(.*)$/);
	if (claudeMatch) {
		const [, family, major, minor, rest] = claudeMatch;
		const name = family.charAt(0).toUpperCase() + family.slice(1);
		const tail = rest ? rest.replace(/^-/, " ").trim() : "";
		return `${name} ${major}.${minor}${tail ? ` (${tail})` : ""}`;
	}

	// GPT family — `gpt-5.4-codex-preview` → `GPT 5.4 Codex (preview)`.
	const gptMatch = id.match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?(?:-([a-z]+))?$/);
	if (gptMatch) {
		const [, ver, variant, suffix] = gptMatch;
		const parts = ["GPT", ver];
		if (variant) parts.push(variant.charAt(0).toUpperCase() + variant.slice(1));
		const out = parts.join(" ");
		return suffix ? `${out} (${suffix})` : out;
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
