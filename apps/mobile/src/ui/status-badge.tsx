import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ViewProps } from "react-native";
import { TextClassContext } from "./text";
import { AppView } from "./view";

/* Mirrors apps/web/src/components/ui/status-badge.tsx: the one way to render a
 * status chip, always through the semantic status tokens. */

const statusBadgeVariants = cva(
	"shrink-0 flex-row items-center gap-1.5 self-start rounded-sm px-1.5 py-0.5",
	{
		variants: {
			status: {
				success: "bg-success-muted",
				warning: "bg-warning-muted",
				destructive: "bg-destructive-muted",
				info: "bg-info-muted",
				neutral: "bg-muted",
			},
		},
		defaultVariants: { status: "neutral" },
	},
);

const statusBadgeTextVariants = cva("text-xs font-medium", {
	variants: {
		status: {
			success: "text-success-muted-foreground",
			warning: "text-warning-muted-foreground",
			destructive: "text-destructive-muted-foreground",
			info: "text-info-muted-foreground",
			neutral: "text-muted-foreground",
		},
	},
	defaultVariants: { status: "neutral" },
});

const statusDotVariants = cva("size-1.5 shrink-0 rounded-full", {
	variants: {
		status: {
			success: "bg-success",
			warning: "bg-warning",
			destructive: "bg-destructive",
			info: "bg-info",
			neutral: "bg-muted-foreground",
		},
	},
	defaultVariants: { status: "neutral" },
});

const statusTextVariants = cva("", {
	variants: {
		status: {
			success: "text-muted-foreground",
			warning: "font-medium text-warning-muted-foreground",
			destructive: "font-medium text-destructive-muted-foreground",
			info: "text-info-muted-foreground",
			neutral: "text-muted-foreground",
		},
	},
	defaultVariants: { status: "neutral" },
});

type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>["status"]>;

function StatusBadge({
	className,
	status = "neutral",
	withDot = false,
	children,
	...props
}: ViewProps & { className?: string; status?: StatusTone; withDot?: boolean }) {
	return (
		<TextClassContext.Provider value={statusBadgeTextVariants({ status })}>
			<AppView className={cn(statusBadgeVariants({ status }), className)} {...props}>
				{withDot ? <StatusDot status={status} /> : null}
				{children}
			</AppView>
		</TextClassContext.Provider>
	);
}

/* Standalone status dot — for lists where a chip is too loud. */
function StatusDot({ className, status = "neutral" }: { className?: string; status?: StatusTone }) {
	return (
		<AppView
			accessibilityElementsHidden
			importantForAccessibility="no"
			className={cn(statusDotVariants({ status }), className)}
		/>
	);
}

export type { StatusTone };
export { StatusBadge, StatusDot, statusDotVariants, statusTextVariants };
