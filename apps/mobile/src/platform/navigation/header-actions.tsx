import { Stack } from "expo-router";
import { useCSSVariable } from "uniwind";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

export function HeaderActions({
	actions = [],
	menu,
}: {
	actions?: HeaderAction[];
	menu?: HeaderMenu;
}) {
	const destructive = useCSSVariable("--color-destructive");
	return (
		<Stack.Toolbar placement="right">
			{actions.map((action) => (
				<Stack.Toolbar.Button
					key={action.id}
					accessibilityLabel={action.accessibilityLabel}
					disabled={action.disabled}
					tintColor={
						action.destructive && typeof destructive === "string" ? destructive : undefined
					}
					onPress={action.onPress}
					style={{ fontFamily: "Geist-Medium" }}
				>
					{action.label}
				</Stack.Toolbar.Button>
			))}
			{menu ? (
				<Stack.Toolbar.Menu accessibilityLabel={menu.label} icon="ellipsis">
					<Stack.Toolbar.Label>{menu.label}</Stack.Toolbar.Label>
					{menu.items.map((action) => (
						<Stack.Toolbar.MenuAction
							key={action.id}
							disabled={action.disabled}
							destructive={action.destructive}
							onPress={action.onPress}
						>
							{action.label}
						</Stack.Toolbar.MenuAction>
					))}
				</Stack.Toolbar.Menu>
			) : null}
		</Stack.Toolbar>
	);
}
