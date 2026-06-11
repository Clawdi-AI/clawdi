/**
 * Memory-specific presentation helpers.
 * Centralized so the list, detail page, and any future memory surface
 * (command palette preview, card view) stay colour-coordinated.
 */

// Category carries meaning, so each gets a distinct muted pastel from the
// semantic token set (taste audit #6) — desaturated, never a raw palette hue.
export const MEMORY_CATEGORY_COLORS: Record<string, string> = {
	fact: "border-transparent bg-muted text-muted-foreground",
	preference: "border-transparent bg-info-muted text-info-muted-foreground",
	pattern: "border-transparent bg-success-muted text-success-muted-foreground",
	decision: "border-transparent bg-warning-muted text-warning-muted-foreground",
	artifact: "border-transparent bg-accent text-accent-foreground",
	context: "border-transparent bg-primary/10 text-primary",
};

/** Object-identity emoji per category (emoji are object avatars, not UI
 * icons — DESIGN.md). One glyph per kind so a wall of memories scans by
 * category at a glance, matching the skill/vault/project card language. */
export const MEMORY_CATEGORY_EMOJI: Record<string, string> = {
	fact: "\u{1F4CC}",
	preference: "\u{1F3AF}",
	pattern: "\u{1F9E9}",
	decision: "\u{2696}\u{FE0F}",
	artifact: "\u{1F4E6}",
	context: "\u{1F9ED}",
};
export const MEMORY_FALLBACK_EMOJI = "\u{1F4DD}";

/** Tinted tile behind the category emoji — same pastel family as
 * MEMORY_CATEGORY_COLORS, minus text color (the emoji carries its own). */
export const MEMORY_CATEGORY_TILE_CLASSES: Record<string, string> = {
	fact: "bg-muted",
	preference: "bg-info-muted",
	pattern: "bg-success-muted",
	decision: "bg-warning-muted",
	artifact: "bg-accent",
	context: "bg-primary/10",
};
