/**
 * The Web shadcn/ui wrappers (apps/web/src/components/ui), rendered from the
 * same @clawdi/shared/ui recipes so the Connect window matches the dashboard.
 */
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
	alertDescriptionClassName,
	alertTitleClassName,
	alertVariants,
	buttonVariants,
	checkboxClasses,
	emptyClassName,
	emptyDescriptionClassName,
	emptyHeaderClassName,
	emptyStateClasses,
	emptyTitleClassName,
	selectClasses,
} from "@clawdi/shared/ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(checkboxClasses.root, className)}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className={checkboxClasses.indicator}
			>
				<CheckIcon />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export const Select = SelectPrimitive.Root;

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
	return (
		<SelectPrimitive.Value
			data-slot="select-value"
			className={cn(selectClasses.value, className)}
			{...props}
		/>
	);
}

export function SelectTrigger({
	className,
	size = "default",
	children,
	...props
}: SelectPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			data-size={size}
			className={cn(selectClasses.trigger, className)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon render={<ChevronDownIcon className={selectClasses.triggerIcon} />} />
		</SelectPrimitive.Trigger>
	);
}

export function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				side="bottom"
				sideOffset={4}
				align="center"
				alignItemWithTrigger={false}
				className="isolate z-50"
			>
				<SelectPrimitive.Popup
					data-slot="select-content"
					data-align-trigger={false}
					className={cn(selectClasses.content, className)}
					{...props}
				>
					<SelectPrimitive.List>{children}</SelectPrimitive.List>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(selectClasses.item, className)}
			{...props}
		>
			<SelectPrimitive.ItemText className={selectClasses.itemText}>
				{children}
			</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator render={<span className={selectClasses.itemIndicator} />}>
				<CheckIcon className={selectClasses.itemIndicatorIcon} />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

export function Alert({
	className,
	variant,
	...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
	return (
		<div
			data-slot="alert"
			role="alert"
			className={cn(alertVariants({ variant }), className)}
			{...props}
		/>
	);
}

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="alert-title" className={cn(alertTitleClassName, className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-description"
			className={cn(alertDescriptionClassName, className)}
			{...props}
		/>
	);
}

/** Web `EmptyState variant="inset"`. */
export function InsetEmptyState({
	title,
	description,
}: {
	title: string;
	description?: ReactNode;
}) {
	return (
		<div data-slot="empty" className={cn(emptyClassName, emptyStateClasses.inset)}>
			<div
				data-slot="empty-header"
				className={cn(emptyHeaderClassName, emptyStateClasses.insetHeader)}
			>
				<div data-slot="empty-title" className={cn(emptyTitleClassName, emptyStateClasses.title)}>
					{title}
				</div>
				{description ? (
					<div data-slot="empty-description" className={emptyDescriptionClassName}>
						{description}
					</div>
				) : null}
			</div>
		</div>
	);
}
