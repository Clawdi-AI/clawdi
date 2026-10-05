import { ENTITY_CARD_BUTTON_FOCUS_CLASS, filterChipClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Content } from "./content";
import { TextClassContext } from "./text";
import { AppPressable } from "./view";
import { resolveWebClasses } from "./web-classes";
export function filterChipClass(active: boolean, className?: string) {
	return cn(
		styles.root,
		ENTITY_CARD_BUTTON_FOCUS_CLASS,
		active ? styles.active : styles.inactive,
		className,
	);
}
export function FilterChip({
	active,
	onClick,
	children,
	className,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
	className?: string;
}) {
	const classes = resolveWebClasses(filterChipClass(active, className));
	return (
		<TextClassContext.Provider value={classes.text}>
			<AppPressable
				accessibilityRole="button"
				accessibilityState={{ selected: active }}
				onPress={onClick}
				className={classes.view}
			>
				{typeof children === "string" || typeof children === "number" ? (
					<Content className={classes.text}>{children}</Content>
				) : (
					children
				)}
			</AppPressable>
		</TextClassContext.Provider>
	);
}
