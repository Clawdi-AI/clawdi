import { toggleGroupClasses as styles, toggleVariants } from "@clawdi/shared/ui";
import { cn } from "cn";
import { Children, createContext, type ReactNode, useContext, useState } from "react";
import { Content } from "./content";
import { TextClassContext } from "./text";
import { AppPressable } from "./view";
import { resolveWebClasses } from "./web-classes";
import { WebView } from "./web-layout";

const GroupContext = createContext({
	value: [] as string[],
	setValue: (_value: string[]) => {},
	multiple: false,
	disabled: false,
	variant: "default" as "default" | "outline",
	size: "default" as "default" | "sm" | "lg",
	spacing: 2,
	orientation: "horizontal",
});
const ItemPositionContext = createContext({ first: false, last: false });
/** Native press toggles replace Base UI; selection remains the Web string[] contract. */
export function ToggleGroup({
	value,
	defaultValue = [],
	onValueChange,
	multiple = false,
	disabled = false,
	variant = "default",
	size = "default",
	spacing = 2,
	orientation = "horizontal",
	className,
	children,
}: {
	value?: string[];
	defaultValue?: string[];
	onValueChange?: (value: string[]) => void;
	multiple?: boolean;
	disabled?: boolean;
	variant?: "default" | "outline";
	size?: "default" | "sm" | "lg";
	spacing?: number;
	orientation?: "horizontal" | "vertical";
	className?: string;
	children: ReactNode;
}) {
	const [internal, setInternal] = useState(defaultValue);
	const items = Children.toArray(children);
	return (
		<GroupContext.Provider
			value={{
				value: value ?? internal,
				setValue: (next) => {
					setInternal(next);
					onValueChange?.(next);
				},
				multiple,
				disabled,
				variant,
				size,
				spacing,
				orientation,
			}}
		>
			<WebView
				recipe={styles.toggleGroup}
				state={{
					"data-vertical": orientation === "vertical",
					"data-[spacing=0]": spacing === 0,
					"data-[variant=outline]": variant === "outline",
				}}
				style={{ gap: spacing * 4 }}
				className={className}
			>
				{items.map((item, index) => (
					<ItemPositionContext.Provider
						key={index}
						value={{ first: index === 0, last: index === items.length - 1 }}
					>
						{item}
					</ItemPositionContext.Provider>
				))}
			</WebView>
		</GroupContext.Provider>
	);
}
export function ToggleGroupItem({
	value,
	disabled,
	variant,
	size,
	className,
	children,
	"aria-label": label,
}: {
	value: string;
	disabled?: boolean;
	variant?: "default" | "outline";
	size?: "default" | "sm" | "lg";
	className?: string;
	children: ReactNode;
	"aria-label"?: string;
}) {
	const group = useContext(GroupContext),
		position = useContext(ItemPositionContext),
		active = group.value.includes(value);
	const classes = resolveWebClasses(
		cn(
			toggleVariants({ variant: group.variant ?? variant, size: group.size ?? size }),
			styles.toggleGroupItem,
		),
		{
			"data-[state=on]": active,
			"group-data-[spacing=0]/toggle-group": group.spacing === 0,
			"data-[spacing=0]": group.spacing === 0,
			"data-[variant=outline]": group.variant === "outline",
			"group-data-horizontal/toggle-group": group.orientation === "horizontal",
			"group-data-vertical/toggle-group": group.orientation === "vertical",
			first: position.first,
			last: position.last,
		},
	);
	return (
		<TextClassContext.Provider value={classes.text}>
			<AppPressable
				accessibilityRole="button"
				accessibilityLabel={label}
				accessibilityState={{ selected: active, disabled: disabled || group.disabled }}
				disabled={disabled || group.disabled}
				className={cn(classes.view, className)}
				onPress={() =>
					group.setValue(
						group.multiple
							? active
								? group.value.filter((item) => item !== value)
								: [...group.value, value]
							: active
								? []
								: [value],
					)
				}
			>
				<Content className={classes.text}>{children}</Content>
			</AppPressable>
		</TextClassContext.Provider>
	);
}
