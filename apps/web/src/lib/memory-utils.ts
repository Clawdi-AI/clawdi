/**
 * Memory-specific presentation helpers.
 * Centralized so the list, detail page, and any future memory surface
 * (command palette preview, card view) stay colour-coordinated.
 */

export const MEMORY_CATEGORY_COLORS: Record<string, string> = {
	fact: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-transparent",
	preference: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-transparent",
	pattern: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-transparent",
	decision: "bg-green-500/10 text-green-700 dark:text-green-400 border-transparent",
	context: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-transparent",
};
