/**
 * Resolves Web (DOM) Tailwind class strings for React Native so mobile renders
 * the exact class definitions Web uses (`@clawdi/shared/ui`) instead of a
 * hand-copied second set.
 *
 * - State variants are resolved against an explicit `state` map, e.g.
 *   `{ "data-active": true, "group-data-[variant=line]/tabs-list": true }`;
 *   unknown or false variants drop the token.
 * - `hover:` becomes `active:` (press feedback); `focus-visible:` becomes
 *   `focus:`; `dark:`, `active:`, `disabled:`, `focus:` stay for Uniwind.
 * - Responsive variants are dropped: the phone layout is the base layout.
 * - Utilities React Native cannot express (selectors, transitions, cursor,
 *   grid, ...) are dropped; a few have direct RN equivalents.
 * - The result is split into view and text classes because RN text does not
 *   inherit from its container.
 *
 * Every class this can emit is safelisted by `scripts/theme.ts` so Uniwind
 * compiles it even though it never appears literally in source.
 */

import { cn } from "cn";

export type WebClassState = Readonly<Record<string, boolean | undefined>>;
export type ResolvedWebClasses = Readonly<{ view: string; text: string }>;

const KEPT_VARIANTS = new Set(["dark", "active", "disabled", "focus"]);
const VARIANT_ALIASES: Readonly<Record<string, string>> = {
	hover: "active",
	"focus-visible": "focus",
	"focus-within": "focus",
};

const DROPPED_UTILITY =
	/^(?:\[|\*|group|peer|transition|duration|ease|animate|outline|cursor-|select-|pointer-events|bg-clip|text-balance|text-pretty|text-wrap|field-sizing|grid|col-|row-|auto-rows|auto-cols|place-|whitespace-|break-|wrap-|underline-offset|decoration|scroll|snap|touch|will-change|isolate|contain|content-|list-|appearance|resize|caret|accent|mix-blend|bg-blend|backdrop|blur|filter|truncate|sr-only|not-sr-only|inline$|block$|table|hidden$|visible$|invisible$|ring-offset|translate|rotate|scale|skew|origin|@container)/;

const TEXT_UTILITY =
	/^(?:text-|font-|leading-|tracking-|italic$|not-italic$|underline$|line-through$|no-underline$|uppercase$|lowercase$|capitalize$|normal-case$|tabular-nums$|proportional-nums$|line-clamp-)/;

const BORDER_WIDTH = /^border(?:-[xytrblse])?(?:-\d+)?$/;

/** Mirrors `* { @apply border-border }` in shared/style/theme.css. */
function withBaseBorder(classes: string[]): string[] {
	return classes.some((token) => BORDER_WIDTH.test(splitVariants(token).utility))
		? ["border-border", ...classes]
		: classes;
}

/** Splits on whitespace while keeping bracketed arbitrary values intact. */
function tokens(className: string): string[] {
	return className.split(/\s+/).filter(Boolean);
}

/** Splits `a:b:[x:y]:util` into variants and the utility, respecting brackets. */
function splitVariants(token: string): { variants: string[]; utility: string } {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of token) {
		if (char === "[" || char === "(") depth += 1;
		if (char === "]" || char === ")") depth -= 1;
		if (char === ":" && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	return { variants: parts, utility: current };
}

function mapUtility(utility: string, hasColumn: boolean): string | null {
	const important = utility.endsWith("!") ? utility.slice(0, -1) : utility;
	if (important === "inline-flex" || (important === "flex" && !hasColumn)) return "flex-row";
	if (important === "flex") return null;
	if (important === "w-fit") return "self-start";
	if (important === "h-fit") return null;
	if (/^space-[xy]-/.test(important)) return important.replace(/^space-[xy]-/, "gap-");
	// A disabled outline must not erase an explicit Web border.
	if (important === "ring-0") return null;
	// Resting rings are hairline outlines; RN has no outline, so use a border.
	if (important === "ring" || important === "ring-1") return "border";
	if (/^ring-[0-9]+$/.test(important)) return important.replace(/^ring-/, "border-");
	if (/^ring-(?!offset)/.test(important)) return important.replace(/^ring-/, "border-");
	if (/^divide-/.test(important)) return null;
	if (important.includes("var(") || important.includes("(--") || important.includes("calc("))
		return null;
	if (DROPPED_UTILITY.test(important)) return null;
	return important;
}

function resolveToken(token: string, state: WebClassState, hasColumn: boolean): string | null {
	const { variants, utility } = splitVariants(token);
	const kept: string[] = [];
	for (const raw of variants) {
		const variant = VARIANT_ALIASES[raw] ?? raw;
		if (KEPT_VARIANTS.has(variant)) {
			if (!kept.includes(variant)) kept.push(variant);
			continue;
		}
		if (state[raw] !== true) return null;
	}
	// Focus/invalid rings are glows, not borders; they have no RN equivalent.
	if (kept.length && utility.startsWith("ring")) return null;
	const mapped = mapUtility(utility, hasColumn);
	if (!mapped) return null;
	// Uniwind applies at most one interaction state per class; keep `dark` first.
	const ordered = kept.sort((a, b) => (a === "dark" ? -1 : b === "dark" ? 1 : 0));
	return [...ordered, mapped].join(":");
}

function isTextToken(resolved: string): boolean {
	const { utility } = splitVariants(resolved);
	return TEXT_UTILITY.test(utility);
}

const cache = new Map<string, ResolvedWebClasses>();

export function resolveWebClasses(
	className: string,
	state: WebClassState = {},
): ResolvedWebClasses {
	const key = `${className}\u0000${JSON.stringify(state)}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const all = tokens(className);
	const hasColumn = all.includes("flex-col");
	const view: string[] = [];
	const text: string[] = [];
	for (const token of all) {
		const resolved = resolveToken(token, state, hasColumn);
		if (!resolved) continue;
		(isTextToken(resolved) ? text : view).push(resolved);
	}
	const result = { view: cn(withBaseBorder(view)), text: cn(text) };
	cache.set(key, result);
	return result;
}

/** Every class `resolveWebClasses` can emit for these sources, for the safelist. */
export function possibleNativeClasses(className: string): string[] {
	const all = tokens(className);
	const hasColumn = all.includes("flex-col");
	const result = new Set<string>();
	for (const token of all) {
		const { variants, utility } = splitVariants(token);
		const permissive = Object.fromEntries(variants.map((variant) => [variant, true]));
		const resolved = resolveToken(token, permissive, hasColumn);
		if (resolved) result.add(resolved);
		const mapped = mapUtility(utility, hasColumn);
		if (mapped) result.add(mapped);
	}
	return withBaseBorder([...result]);
}
