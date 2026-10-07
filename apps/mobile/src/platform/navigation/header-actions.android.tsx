import {
	Badge,
	Box,
	DropdownMenu,
	DropdownMenuItem,
	HorizontalDivider,
	Host,
	Icon,
	IconButton,
	Row,
	Text,
	TextButton,
} from "@expo/ui/jetpack-compose";
import { semantics } from "@expo/ui/jetpack-compose/modifiers";
import { Stack } from "expo-router";
import { useState } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import { headerMenuGroups } from "@/platform/navigation/header-menu";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

// Material "check" vector, as expo-router's Android toolbar menu marks `isOn` actions.
const checkIcon = require("../../../assets/icons/check.xml");

/** Inline sections and checked state follow expo-router's Android toolbar menu: divider, trailing check. */
export function HeaderActions({
	actions = [],
	menu,
}: {
	actions?: HeaderAction[];
	menu?: HeaderMenu;
}) {
	const [expanded, setExpanded] = useState(false);
	const { theme } = useUniwind();
	const [foreground, destructive, popover, destructiveForeground] = useCSSVariable([
		"--color-foreground",
		"--color-destructive",
		"--color-popover",
		"--color-destructive-foreground",
	]);
	const color = (value: string | number | undefined) =>
		typeof value === "string" ? value : undefined;
	const menuItem = (action: HeaderAction) => (
		<DropdownMenuItem
			key={action.id}
			enabled={!action.disabled}
			onClick={() => {
				setExpanded(false);
				action.onPress();
			}}
			elementColors={{ textColor: color(action.destructive ? destructive : foreground) }}
		>
			<DropdownMenuItem.Text>
				<Text style={{ fontFamily: "Geist-Regular", fontSize: 14 }}>{action.label}</Text>
			</DropdownMenuItem.Text>
			{action.selected ? (
				<DropdownMenuItem.TrailingIcon>
					<Icon source={checkIcon} tint={color(foreground)} size={24} />
				</DropdownMenuItem.TrailingIcon>
			) : null}
		</DropdownMenuItem>
	);
	return (
		<Stack.Toolbar placement="right" asChild>
			<Host matchContents colorScheme={theme === "dark" ? "dark" : "light"}>
				<Row verticalAlignment="center">
					{actions.map((action) =>
						action.icon ? (
							// Same Material 3 composition as expo-router's Android toolbar badge.
							<Box key={action.id} contentAlignment="topEnd">
								<IconButton onClick={action.onPress} enabled={!action.disabled}>
									<Icon
										source={action.icon.android}
										tint={color(foreground)}
										size={24}
										contentDescription={action.accessibilityLabel ?? action.label}
									/>
								</IconButton>
								{action.badge ? (
									<Badge
										containerColor={color(destructive)}
										contentColor={color(destructiveForeground)}
									>
										<Text style={{ typography: "labelSmall", fontFamily: "Geist-Medium" }}>
											{action.badge}
										</Text>
									</Badge>
								) : null}
							</Box>
						) : (
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
						),
					)}
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
								{headerMenuGroups(menu).flatMap((group, index) => [
									index > 0 ? <HorizontalDivider key={`divider-${group.id}`} /> : null,
									...group.items.map(menuItem),
								])}
							</DropdownMenu.Items>
						</DropdownMenu>
					) : null}
				</Row>
			</Host>
		</Stack.Toolbar>
	);
}
