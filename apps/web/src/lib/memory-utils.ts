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
	context: "border-transparent bg-primary/10 text-primary",
};
