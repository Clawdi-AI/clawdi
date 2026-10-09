// Named parts for native wrappers: RN draws rings as borders and lays out the hero
// in two views, so the app composes these instead of stripping classes by pattern.
const CHOICE_SELECTED_FILL = "border-primary bg-primary/5";
const HERO_FRAME = "flex min-h-36 flex-col";
const ADD_SURFACE = "border-dashed bg-card";

/** Verbatim Web recipes from components/entity-card; shared with native wrappers. */
export const entityCardClasses = {
	resourceChassis: "min-w-0 rounded-xl border bg-card p-5",
	compactChassis: "min-w-0 rounded-lg border bg-card p-4",
	resourceGrid: "grid gap-4 sm:grid-cols-2 xl:grid-cols-3",
	compactGrid: "grid gap-2 sm:grid-cols-2 xl:grid-cols-3",
	masonry: "columns-1 gap-4 sm:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid",
	choiceGrid: "grid gap-2 @2xl/main:grid-cols-2",
	compactLink:
		"absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
	resourceLink:
		"absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
	buttonFocus:
		"focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
	responsiveActions:
		"relative z-10 flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity duration-150 max-sm:[&_button]:min-h-11 max-sm:[&_button[aria-label]]:min-w-11 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100",
	alwaysActions:
		"relative z-10 flex shrink-0 items-center gap-2 max-sm:[&_button]:min-h-11 max-sm:[&_button[aria-label]]:min-w-11",
	chassis: "group relative z-0 transition-all duration-150",
	resourceInteractive:
		"hover:-translate-y-px hover:border-foreground/20 focus-within:-translate-y-px focus-within:border-foreground/20",
	compactInteractive: "hover:bg-muted/50 focus-within:bg-muted/50",
	actionsInteractive: "pointer-events-auto",
	compactChoice: "min-w-0 rounded-md border border-border bg-muted/30 p-2.5",
	choiceRoot: "flex w-full text-left transition-colors",
	choiceCompactLayout: "items-center gap-2.5",
	choiceLayout: "items-start gap-3",
	choiceSelected: `${CHOICE_SELECTED_FILL} ring-1 ring-primary/30`,
	choiceSelectedFill: CHOICE_SELECTED_FILL,
	compactChoiceInteractive: "hover:bg-muted/60",
	choiceInteractive: "hover:bg-muted/50",
	disabled: "pointer-events-none opacity-60",
	skeletonRow: "flex items-start gap-3",
	skeletonLayout: "flex gap-3",
	skeletonAlignStart: "items-start",
	skeletonAlignCenter: "items-center",
	shrink: "shrink-0",
	smallSkeletonIcon: "size-8 rounded-md",
	skeletonIcon: "size-10 rounded-lg",
	body: "min-w-0 flex-1",
	titleRow: "flex min-w-0 items-center gap-1.5",
	skeletonDot: "size-1.5 shrink-0 rounded-full",
	skeletonTitleRow: "flex min-w-0 items-center gap-1.5 text-sm",
	skeletonTitle: "h-lh min-w-16 max-w-32 flex-1",
	skeletonBadge: "h-5 w-16 shrink-0 rounded-full",
	skeletonMetaLines: "mt-0.5 space-y-1 text-sm",
	skeletonMeta: "h-lh w-40 max-w-[80%]",
	skeletonSecondMeta: "h-lh w-full max-w-56",
	skeletonActions: "mt-3 flex items-center gap-2",
	skeletonPrimaryAction: "h-8 w-20 rounded-md",
	skeletonSecondaryAction: "h-8 w-14 rounded-md",
	skeletonMoreAction: "ml-auto size-8 rounded-md",
	heroSkeletonRoot: "flex flex-col",
	compactHeroSkeleton: "min-h-28 gap-2",
	heroSkeleton: "min-h-36 gap-3",
	compactHeroSkeletonIcon: "size-8 rounded-lg",
	heroSkeletonBody: "min-w-0",
	heroSkeletonTitleLine: "text-sm",
	heroSkeletonTitle: "h-lh w-40 max-w-full",
	heroSkeletonDescriptionLine: "mt-1 text-xs leading-relaxed",
	heroSkeletonDescription: "h-lh w-56 max-w-[85%]",
	heroSkeletonFooter: "mt-auto flex items-center gap-3 text-xs",
	heroSkeletonFirstFact: "h-lh w-16",
	heroSkeletonSecondFact: "h-lh w-28 max-w-[45%]",
	meta: "mt-0.5 flex min-w-0 items-center text-sm text-muted-foreground",
	metaWrap: "flex-wrap gap-x-3 gap-y-1 overflow-visible",
	metaTruncate: "overflow-hidden",
	metaItem: "inline-flex min-w-0 items-center",
	metaItemWrap: "max-w-full shrink-0",
	metaSeparator: "mx-1.5 shrink-0 text-muted-foreground/40",
	metaText: "min-w-0 truncate",
	header: "flex min-w-0 gap-3",
	headerStart: "items-start",
	headerCenter: "items-center",
	headerTitleRow: "flex min-w-0 items-center gap-2",
	title: "min-w-0 flex-1 truncate text-sm font-medium",
	hero: `${HERO_FRAME} gap-3`,
	heroFrame: HERO_FRAME,
	heroStack: "flex flex-col gap-3",
	heroTop: "flex items-start justify-between gap-2",
	heroBody: "min-w-0",
	heroBadges: "flex shrink-0 items-center gap-1.5",
	heroDescription: "mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground",
	heroFooter: "mt-auto text-xs text-muted-foreground tabular-nums",
	trailing: "pointer-events-auto relative z-10 shrink-0",
	rowButton: "flex w-full items-center gap-3 text-left",
	rowLinkContainer: "group relative z-0 min-w-0",
	rowLinkBody:
		"pointer-events-none z-10 flex items-center gap-3 group-hover:bg-muted/50 group-focus-within:bg-muted/50",
	chevron: "size-4 shrink-0 text-muted-foreground/60",
	row: "flex items-center gap-3",
	choiceIcon: "flex shrink-0",
	choiceResponsiveDetails:
		"flex flex-col gap-2 @md/choice:flex-row @md/choice:items-start @md/choice:gap-3",
	choiceDescription: "mt-0.5 text-muted-foreground",
	compactChoiceDescription: "truncate text-xs leading-4",
	fullChoiceDescription: "break-words text-sm",
	choiceTrailingDetails: "max-w-[45%] shrink-0",
	choiceResponsiveDetailsBody:
		"w-full @md/choice:w-auto @md/choice:max-w-[52%] @md/choice:shrink-0",
	choiceStackedDetails: "mt-2",
	choiceIndicator: "flex size-4 shrink-0 self-center items-center justify-center",
	choiceCheck: "size-4 text-primary",
	addTint: "bg-muted text-muted-foreground",
	add: `h-full ${ADD_SURFACE}`,
	addSurface: ADD_SURFACE,
} as const;

export type EntityCardVariant = "resource" | "compact";

/** Stable chassis tokens. Resource cards preserve richer content; compact
 * cards favor dense catalogs without leaving the entity-card family. */
export const ENTITY_CARD_CHASSIS_CLASS: Record<EntityCardVariant, string> = {
	resource: entityCardClasses.resourceChassis,
	compact: entityCardClasses.compactChassis,
};

export const ENTITY_CARD_GRID_CLASS: Record<EntityCardVariant, string> = {
	resource: entityCardClasses.resourceGrid,
	compact: entityCardClasses.compactGrid,
};

/** Variable-height resource notes keep the same responsive columns and gap
 * while avoiding the empty vertical space of equal-height grid rows. */
export const ENTITY_CARD_MASONRY_CLASS = entityCardClasses.masonry;

/** Compatibility names for established non-resource callers. New resource
 * components should use the semantic chassis/grid contract above. */
export const ENTITY_CARD_BASE = ENTITY_CARD_CHASSIS_CLASS.compact;
export const HERO_CARD_BASE = ENTITY_CARD_CHASSIS_CLASS.resource;
export const HERO_GRID_CLASS = ENTITY_CARD_GRID_CLASS.resource;
export const ENTITY_GRID_CLASS = ENTITY_CARD_GRID_CLASS.compact;

/** Form-local choice cards follow their named main container instead of the viewport. */
export const ENTITY_CHOICE_GRID_CLASS = entityCardClasses.choiceGrid;

/** Stretched link that makes a whole card navigate while keeping inner
 * controls independently clickable — pairs with a `relative z-0` wrapper. */
export const ENTITY_CARD_STRETCHED_LINK_CLASS: Record<EntityCardVariant, string> = {
	compact: entityCardClasses.compactLink,
	resource: entityCardClasses.resourceLink,
};

export const ENTITY_STRETCHED_LINK_CLASS = ENTITY_CARD_STRETCHED_LINK_CLASS.compact;
export const HERO_STRETCHED_LINK_CLASS = ENTITY_CARD_STRETCHED_LINK_CLASS.resource;

/** Focus ring for whole-card buttons matching the stretched-link treatment. */
export const ENTITY_CARD_BUTTON_FOCUS_CLASS = entityCardClasses.buttonFocus;

/**
 * Card actions stay visible and comfortably tappable on touch screens, then
 * recede until hover or keyboard focus on larger screens. Keep this in the
 * shared slot so Project, Skill, Vault, and note-style Memory cards do not
 * each invent a different action rhythm.
 */
export const ENTITY_CARD_ACTIONS_CLASS = entityCardClasses.responsiveActions;
export const ENTITY_CARD_ACTIONS_ALWAYS_CLASS = entityCardClasses.alwaysActions;
