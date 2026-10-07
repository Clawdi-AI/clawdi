/**
 * Web shadcn/ui variant definitions and class strings, shared verbatim with the
 * mobile app so both render from one design source. Web components in
 * apps/web/src/components/ui consume these directly; mobile resolves the same
 * strings for React Native (apps/mobile/src/ui/web-classes.ts).
 */
import { cva } from "class-variance-authority";

export const buttonVariants = cva(
	"group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/80",
				outline:
					"border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
				ghost:
					"hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
				destructive:
					"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default:
					"h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
				lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				icon: "size-9",
				"icon-xs":
					"size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm":
					"size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export const badgeVariants = cva(
	"group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
				secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
				destructive:
					"bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
				outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
				ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
				link: "text-primary underline-offset-4 hover:underline",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

/** Web badge descendant SVG scale, exposed for native icons. */
export const statusBadgeIconClassName = "size-3";

export const statusBadgeVariants = cva(
	"inline-flex w-fit shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
	{
		variants: {
			status: {
				success: "bg-success-muted text-success-muted-foreground",
				warning: "bg-warning-muted text-warning-muted-foreground",
				destructive: "bg-destructive-muted text-destructive-muted-foreground",
				info: "bg-info-muted text-info-muted-foreground",
				neutral: "bg-muted text-muted-foreground",
			},
		},
		defaultVariants: {
			status: "neutral",
		},
	},
);

export const statusDotVariants = cva("size-1.5 shrink-0 rounded-full", {
	variants: {
		status: {
			success: "bg-success",
			warning: "bg-warning",
			destructive: "bg-destructive",
			info: "bg-info",
			neutral: "bg-muted-foreground",
		},
	},
	defaultVariants: {
		status: "neutral",
	},
});

export const statusTextVariants = cva("", {
	variants: {
		status: {
			success: "text-muted-foreground",
			warning: "text-warning-muted-foreground font-medium",
			destructive: "text-destructive-muted-foreground font-medium",
			info: "text-info-muted-foreground",
			neutral: "text-muted-foreground",
		},
	},
	defaultVariants: {
		status: "neutral",
	},
});

export const alertVariants = cva(
	"group/alert relative grid w-full gap-0.5 rounded-lg border px-4 py-3 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-card text-card-foreground",
				destructive:
					"bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export const emptyMediaVariants = cva(
	"mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-transparent",
				icon: "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-6",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export const tabsListVariants = cva(
	"group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
	{
		variants: {
			variant: {
				default: "bg-muted",
				line: "gap-1 bg-transparent",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export const cardClassName =
	"group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground shadow-xs ring-1 ring-foreground/10 [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl";

export const cardHeaderClassName =
	"group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)";

export const cardTitleClassName =
	"text-base leading-normal font-medium group-data-[size=sm]/card:text-sm";

export const cardDescriptionClassName = "text-sm text-muted-foreground";

export const cardActionClassName = "col-start-2 row-span-2 row-start-1 self-start justify-self-end";

export const cardContentClassName = "flex flex-col gap-3 px-(--card-spacing)";

export const cardFooterClassName =
	"flex items-center rounded-b-xl px-(--card-spacing) [.border-t]:pt-(--card-spacing)";

export const alertTitleClassName =
	"font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground";

export const alertDescriptionClassName =
	"text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4";

export const emptyClassName =
	"flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border-dashed p-12 text-center text-balance";

export const emptyHeaderClassName = "flex max-w-sm flex-col items-center gap-2";

export const emptyTitleClassName = "text-lg font-medium tracking-tight";

export const emptyDescriptionClassName =
	"text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary";

export const emptyContentClassName =
	"flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance";

export const skeletonClassName = "animate-pulse rounded-md bg-muted";

export const separatorClassName =
	"shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch";

export const inputClassName =
	"h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export const textareaClassName =
	"flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export const labelClassName =
	"flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50";

export const tabsClassName = "group/tabs flex gap-2 data-horizontal:flex-col";

export const tabsTriggerClassName =
	"relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export const tabsTriggerLineClassName =
	"group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent";

export const tabsTriggerActiveClassName =
	"data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground";

export const tabsTriggerIndicatorClassName =
	"after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100";

export const tabsContentClassName = "flex-1 text-sm outline-none";

export * from "./account-alias-dialog";
export * from "./account-alias-field";
export * from "./add-agent-setup";
export * from "./add-keys-dialog";
export * from "./agent-channel-section";
export * from "./agent-framework-icon";
export * from "./agent-icon";
export * from "./agent-label";
export * from "./agent-overview-capabilities";
export * from "./agent-overview-layout";
export * from "./agent-plugin-card";
export * from "./agent-plugins-surface";
export * from "./agent-profiles";
export * from "./agent-settings-panel";
export * from "./agent-source-badge";
export * from "./agents-card";
export * from "./agents-index";
export * from "./ai-providers-page";
export * from "./ai-providers-ui";
export * from "./alert-dialog";
export * from "./api-error-panel";
export * from "./api-keys-panel";
export * from "./auth-page";
export * from "./auto-reload-card";
export * from "./balance-card";
export * from "./billing-page";
export * from "./brand-icon-tile";
export * from "./channel-card";
export * from "./channel-detail-page";
export * from "./channels-page";
export * from "./checkbox";
export * from "./compute-dunning-banner";
export * from "./compute-status-details";
export * from "./compute-subscription-card";
export * from "./confirm-action";
export * from "./connect-bot-dialog";
export * from "./connected-agent-detail";
export * from "./contribution-graph";
export * from "./copy-keys-dialog";
export * from "./create-project-dialog";
export * from "./create-skill-dialog";
export * from "./credentials-dialog";
export * from "./dashboard-page";
export * from "./data-table-faceted-filter";
export * from "./data-table-pagination";
export * from "./deploy-wizard";
export * from "./dialog";
export * from "./dropdown-menu";
export * from "./empty-state";
export * from "./entity-brand-icons";
export * from "./entity-card";
export * from "./entity-icon";
export * from "./filter-chip";
export * from "./form-layout";
export * from "./general-panel";
export * from "./global-wallet-balance";
export * from "./header-action-group";
export * from "./hosted-agent-overview";
export * from "./icon-chip";
export * from "./initial-deployment";
export * from "./input-group";
export * from "./library-surfaces";
export * from "./list-toolbar";
export * from "./managed-model-picker";
export * from "./markdown";
export * from "./message-list";
export * from "./onboarding-card";
export * from "./overview-compute-body";
export * from "./page-header";
export * from "./page-width";
export * from "./payment-methods-section";
export * from "./plan-comparison";
export * from "./project-actions";
export * from "./project-metadata";
export * from "./project-share-page";
export * from "./project-vault-catalog";
export * from "./provider-chooser";
export * from "./provider-dialog";
export * from "./provider-fields-form";
export * from "./provider-oauth-flow";
export * from "./public-session";
export * from "./resource-identity";
export * from "./resources-card";
export * from "./route-loading-skeleton";
export * from "./search-highlighted-text";
export * from "./section";
export * from "./section-label";
export * from "./select";
export * from "./send-skill-dialog";
export * from "./session-detail";
export * from "./session-feed";
export * from "./session-model-badge";
export * from "./session-sidebar";
export * from "./session-stat";
export * from "./sessions-page";
export * from "./settings-dialog";
export * from "./settings-panel-header";
export * from "./settings-section";
export * from "./share-controls";
export * from "./shared-session-links";
export * from "./sheet";
export * from "./site-header";
export * from "./skill-transfer-dialog";
export * from "./split-vault-dialog";
export * from "./subscription-source-picker";
export * from "./switch";
export * from "./term-switcher";
export * from "./this-week-card";
export * from "./toggle";
export * from "./toggle-group";
export * from "./transactions-section";
export * from "./vault-request";
export * from "./whatsapp-device-onboarding";
export * from "./workspace-skills-panel";
