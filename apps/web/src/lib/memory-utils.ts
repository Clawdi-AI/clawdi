/**
 * Memory-specific presentation helpers.
 * Centralized so the list, detail page, and any future memory surface
 * (command palette preview, card view) stay colour-coordinated.
 */

export const MEMORY_CATEGORY_COLORS: Record<string, string> = {
	fact: "border-border bg-muted/60 text-muted-foreground",
	preference: "border-border bg-muted/60 text-muted-foreground",
	pattern: "border-border bg-muted/60 text-muted-foreground",
	decision: "border-border bg-muted/60 text-muted-foreground",
	context: "border-border bg-muted/60 text-muted-foreground",
};
