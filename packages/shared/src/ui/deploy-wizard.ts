// Named parts let the app drop Web-only page gutters without stripping classes by pattern.
const BILLING_TERM_LAYOUT = "flex flex-col gap-1.5";
const ACTION_BAR_SURFACE =
	"sticky bottom-0 z-10 border-t bg-background/90 px-4 pt-3 pb-[calc(--spacing(3)+env(safe-area-inset-bottom))] backdrop-blur lg:px-6";

export const deployWizardClasses = {
	performanceTint: "bg-identity-8-bg text-identity-8-fg",
	planPrice: "flex min-w-0 flex-col items-end text-right tabular-nums",
	planPriceHeading: "flex items-baseline justify-end leading-5",
	planPriceValue: "whitespace-nowrap text-sm font-semibold text-foreground",
	planPriceMeta: "text-xs leading-4 font-normal text-muted-foreground",
	priceSegment: "whitespace-nowrap",
	specs: "text-xs",
	form: "flex flex-col gap-6",
	providerChoices: "flex flex-col gap-4",
	providerSkeleton: "h-[74px] w-full rounded-lg",
	providerError: "@2xl/main:col-span-2",
	compute: "flex min-w-0 flex-col gap-4",
	loadingPlans: "flex items-center gap-2 text-sm text-muted-foreground",
	actionIcon: "size-3.5",
	billingTerm: `${BILLING_TERM_LAYOUT} max-w-xs`,
	/** Term switcher without Web's width cap; the native control spans the form. */
	billingTermLayout: BILLING_TERM_LAYOUT,
	fieldLabel: "text-xs text-muted-foreground",
	computeChoice: "items-center p-3",
	paymentMethods: "flex flex-col gap-3",
	fieldTitle: "text-sm font-medium",
	error: "text-xs text-destructive",
	personalizeSection: "pb-32 @2xl/main:pb-24",
	personalize: "flex flex-wrap items-start gap-4",
	nameField: "flex w-64 flex-col gap-1.5",
	screenReaderOnly: "sr-only",
	languageField: "flex flex-col gap-1.5",
	timezoneField: "flex w-64 min-w-0 flex-col gap-1.5",
	actionBar: `${ACTION_BAR_SURFACE} -mx-4 lg:-mx-6`,
	/** Action bar without the negative margins that cancel Web's page padding. */
	actionBarSurface: ACTION_BAR_SURFACE,
	hydrationError: "mb-3",
	actionBarContent:
		"flex flex-col gap-2 @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-between",
	configurationSummary: "min-w-0 truncate text-xs text-muted-foreground sm:text-sm",
	checkout:
		"flex w-full shrink-0 flex-col gap-2 @2xl/main:w-auto @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-end",
	amount: "flex min-w-0 flex-col @2xl/main:w-56 @2xl/main:items-end @2xl/main:text-right",
	amountHeading: "flex flex-wrap items-center gap-x-2 gap-y-0.5 @2xl/main:justify-end",
	amountValue: "font-semibold tabular-nums text-foreground",
	refreshQuote: "h-auto p-0",
	amountCaption: "whitespace-nowrap text-xs text-muted-foreground",
	amountError: "whitespace-nowrap text-xs font-medium text-destructive",
	submitGroup: "flex min-w-0 flex-col gap-1 @2xl/main:w-40 @2xl/main:items-end",
	submit: "w-full shrink-0",
	blockingReason: "mt-1 max-w-sm text-xs @2xl/main:ml-auto @2xl/main:text-right",
} as const;
