/** Verbatim recipes from apps/web/src/components/sessions/message-list.tsx. */
export const messageListClasses = {
	dateDivider: "my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground",
	hairline: "h-px flex-1 bg-border",
	messageRow: "group flex scroll-mt-24 gap-3 rounded-md border-l-2 border-transparent p-2",
	highlighted: "border-primary bg-primary/5",
	avatarColumn: "w-8 shrink-0 pt-0.5",
	userAvatar:
		"flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium",
	continuationTime:
		"hidden h-5 w-8 items-center justify-end pr-1 text-3xs tabular-nums text-muted-foreground/60 group-hover:flex [@media(hover:none)]:flex",
	content: "min-w-0 flex-1",
	messageHeader: "mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5",
	author: "text-sm font-medium",
	timestamp: "whitespace-nowrap text-xs text-muted-foreground",
	body: "text-sm wrap-anywhere",
	userBubble: "w-fit max-w-full rounded-lg bg-accent/60 px-3 py-2",
	actions:
		"pointer-events-none mt-0.5 flex min-h-6 w-fit items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
	actionButton: "text-muted-foreground pointer-coarse:size-11",
	command:
		"inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-xs",
	commandName: "font-medium text-primary",
	commandArgs: "break-all text-muted-foreground",
	commandIcon: "size-3 shrink-0 text-primary",
	stack: "space-y-2",
	skill: "rounded-md border border-dashed border-border/70 bg-muted/30",
	skillTrigger:
		"h-auto w-full justify-start rounded-md px-2.5 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground",
	skillBody: "border-t border-border/50 px-3 py-2",
	muted: "text-xs text-muted-foreground",
	toolRow: "flex gap-3 py-1.5",
	toolIconColumn: "flex w-8 shrink-0 justify-center pt-2 text-muted-foreground",
	toolIcon: "size-3.5",
	toolTrigger:
		"flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent",
	toolName: "truncate font-medium text-foreground",
	toolStatus: "inline-flex shrink-0 items-center gap-1",
	toolError: "inline-flex shrink-0 items-center gap-1 text-destructive",
	toolTime: "ml-auto shrink-0 tabular-nums",
	toolDetails: "px-2 pb-2 pt-1",
	payload:
		"max-h-80 overflow-auto whitespace-pre-wrap break-all border-l-2 border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground",
	payloadLabel: "text-3xs font-medium uppercase text-muted-foreground",
	tabs: "min-w-0 gap-1.5",
	tabList: "h-7",
	tab: "h-7 px-1.5 text-xs",
	groupStart: "pt-2",
} as const;
