/** Verbatim Web InputGroup recipes used by native SearchInput. */
import { cva } from "class-variance-authority";
export const inputGroupClasses = {
	InputGroup:
		"group/input-group relative flex h-9 w-full min-w-0 items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] outline-none in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto dark:bg-input/30 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
	inputGroupAddonVariants:
		"flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
	inputGroupAddonVariants2: "order-first pl-2 has-[>button]:-ml-1 has-[>kbd]:ml-[-0.15rem]",
	inputGroupAddonVariants3: "order-last pr-2 has-[>button]:-mr-1 has-[>kbd]:mr-[-0.15rem]",
	inputGroupAddonVariants4:
		"order-first w-full justify-start px-2.5 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2",
	inputGroupAddonVariants5:
		"order-last w-full justify-start px-2.5 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2",
	inputGroupButtonVariants: "flex items-center gap-2 text-sm shadow-none",
	inputGroupButtonVariants2:
		"h-6 gap-1 rounded-[calc(var(--radius)-5px)] px-1.5 [&>svg:not([class*='size-'])]:size-3.5",
	inputGroupButtonVariants3: "size-6 rounded-[calc(var(--radius)-5px)] p-0 has-[>svg]:p-0",
	inputGroupButtonVariants4: "size-8 p-0 has-[>svg]:p-0",
	InputGroupText:
		"flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
	InputGroupInput:
		"flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
	InputGroupTextarea:
		"flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
} as const;

export const inputGroupAddonVariants = cva(inputGroupClasses.inputGroupAddonVariants, {
	variants: {
		align: {
			"inline-start": inputGroupClasses.inputGroupAddonVariants2,
			"inline-end": inputGroupClasses.inputGroupAddonVariants3,
			"block-start": inputGroupClasses.inputGroupAddonVariants4,
			"block-end": inputGroupClasses.inputGroupAddonVariants5,
		},
	},
	defaultVariants: {
		align: "inline-start",
	},
});

export const inputGroupButtonVariants = cva(inputGroupClasses.inputGroupButtonVariants, {
	variants: {
		size: {
			xs: inputGroupClasses.inputGroupButtonVariants2,
			sm: "",
			"icon-xs": inputGroupClasses.inputGroupButtonVariants3,
			"icon-sm": inputGroupClasses.inputGroupButtonVariants4,
		},
	},
	defaultVariants: {
		size: "xs",
	},
});
