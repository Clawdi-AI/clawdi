import {
	DropdownMenu,
	DropdownMenuItem,
	Host,
	Row,
	Text,
	TextButton,
} from "@expo/ui/jetpack-compose";
import { semantics } from "@expo/ui/jetpack-compose/modifiers";
import { Stack } from "expo-router";
import { useState } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

export function HeaderActions({
	actions = [],
	menu,
}: {
	actions?: HeaderAction[];
	menu?: HeaderMenu;
}) {
	const [expanded, setExpanded] = useState(false);
	const { theme } = useUniwind();
	const [foreground, destructive, popover] = useCSSVariable([
		"--color-foreground",
		"--color-destructive",
		"--color-popover",
	]);
	const color = (value: string | number | undefined) =>
		typeof value === "string" ? value : undefined;
	return (
		<Stack.Toolbar placement="right" asChild>
			<Host matchContents colorScheme={theme === "dark" ? "dark" : "light"}>
				<Row verticalAlignment="center">
					{actions.map((action) => (
						<TextButton
							key={action.id}
							enabled={!action.disabled}
							onClick={action.onPress}
							modifiers={[
								semantics({ contentDescription: action.accessibilityLabel ?? action.label }),
							]}
							colors={{ contentColor: color(action.destructive ? destructive : foreground) }}
						>
							<Text style={{ fontFamily: "Geist-Medium", fontSize: 14 }}>{action.label}</Text>
						</TextButton>
					))}
					{menu ? (
						<DropdownMenu
							expanded={expanded}
							onDismissRequest={() => setExpanded(false)}
							color={color(popover)}
						>
							<DropdownMenu.Trigger>
								<TextButton
									onClick={() => setExpanded(true)}
									colors={{ contentColor: color(foreground) }}
									modifiers={[semantics({ contentDescription: menu.label })]}
								>
									<Text style={{ fontSize: 24 }}>…</Text>
								</TextButton>
							</DropdownMenu.Trigger>
							<DropdownMenu.Items>
								{menu.items.map((action) => (
									<DropdownMenuItem
										key={action.id}
										enabled={!action.disabled}
										onClick={() => {
											setExpanded(false);
											action.onPress();
										}}
										elementColors={{
											textColor: color(action.destructive ? destructive : foreground),
										}}
									>
										<DropdownMenuItem.Text>
											<Text style={{ fontFamily: "Geist-Regular", fontSize: 14 }}>
												{action.label}
											</Text>
										</DropdownMenuItem.Text>
									</DropdownMenuItem>
								))}
							</DropdownMenu.Items>
						</DropdownMenu>
					) : null}
				</Row>
			</Host>
		</Stack.Toolbar>
	);
}
