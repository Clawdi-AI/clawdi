import {
	tabsClassName,
	tabsContentClassName,
	tabsListVariants,
	tabsTriggerActiveClassName,
	tabsTriggerClassName,
	tabsTriggerIndicatorClassName,
	tabsTriggerLineClassName,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Content } from "@/components/ui/content";
import { TextClassContext } from "@/components/ui/text";
import { AppPressable, AppView } from "@/components/ui/view";
import { resolveWebClasses } from "@/lib/web-classes";
import { WebView } from "@/components/ui/web-layout";

export { tabsListVariants } from "@clawdi/shared/ui";

const TabsContext = createContext({
	value: "",
	setValue: (_value: string) => {},
	orientation: "horizontal",
});
const ListContext = createContext<"default" | "line">("line");
/** Native segmented tabs; line is the dashboard underline treatment. No keyboard/hover behavior. */
export function Tabs({
	value,
	defaultValue = "",
	onValueChange,
	orientation = "horizontal",
	className,
	children,
}: {
	value?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	orientation?: "horizontal" | "vertical";
	className?: string;
	children: ReactNode;
}) {
	const [internal, setInternal] = useState(defaultValue);
	return (
		<TabsContext.Provider
			value={{
				value: value ?? internal,
				setValue: (next) => {
					setInternal(next);
					onValueChange?.(next);
				},
				orientation,
			}}
		>
			<WebView
				recipe={tabsClassName}
				state={{ "data-horizontal": orientation === "horizontal" }}
				className={className}
			>
				{children}
			</WebView>
		</TabsContext.Provider>
	);
}
export function TabsList({
	variant = "line",
	className,
	children,
}: {
	variant?: "default" | "line";
	className?: string;
	children: ReactNode;
}) {
	const { orientation } = useContext(TabsContext);
	return (
		<ListContext.Provider value={variant}>
			<WebView
				recipe={tabsListVariants({ variant })}
				state={{
					"group-data-horizontal/tabs": orientation === "horizontal",
					"group-data-vertical/tabs": orientation === "vertical",
					"data-[variant=line]": variant === "line",
				}}
				className={className}
			>
				{children}
			</WebView>
		</ListContext.Provider>
	);
}
export function TabsTrigger({
	value,
	disabled,
	className,
	children,
}: {
	value: string;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const tabs = useContext(TabsContext),
		variant = useContext(ListContext),
		active = tabs.value === value;
	const state = {
		"data-active": active,
		"group-data-[variant=default]/tabs-list": variant === "default",
		"group-data-[variant=line]/tabs-list": variant === "line",
		"group-data-vertical/tabs": tabs.orientation === "vertical",
	};
	const classes = resolveWebClasses(
		cn(tabsTriggerClassName, tabsTriggerActiveClassName, tabsTriggerLineClassName, className),
		state,
	);
	// Web draws the underline with ::after. Resolve that same recipe on a child View.
	const indicator = resolveWebClasses(tabsTriggerIndicatorClassName.replace(/after:/g, ""), {
		...state,
		"group-data-horizontal/tabs": tabs.orientation === "horizontal",
	});
	return (
		<TextClassContext.Provider value={classes.text}>
			<AppPressable
				accessibilityRole="tab"
				accessibilityState={{ selected: active, disabled }}
				disabled={disabled}
				onPress={() => tabs.setValue(value)}
				className={classes.view}
			>
				<Content className={classes.text}>{children}</Content>
				{variant === "line" ? <AppView pointerEvents="none" className={indicator.view} /> : null}
			</AppPressable>
		</TextClassContext.Provider>
	);
}
export function TabsContent({
	value,
	className,
	children,
	keepMounted = false,
}: {
	value: string;
	className?: string;
	children: ReactNode;
	keepMounted?: boolean;
}) {
	const active = useContext(TabsContext).value === value;
	if (!active && !keepMounted) return null;
	return (
		<WebView
			recipe={tabsContentClassName}
			className={className}
			style={!active ? { display: "none" } : undefined}
		>
			{children}
		</WebView>
	);
}
