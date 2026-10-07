import { ListItem } from "@expo/ui";
import { HorizontalDivider, Host, LazyColumn, RNHostView, Text } from "@expo/ui/jetpack-compose";
import { testID } from "@expo/ui/jetpack-compose/modifiers";
import { Fragment } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import { IconChip } from "@/components/icon-chip";
import type { SettingsMenuSection } from "@/components/settings/settings-menu";
import { Icon } from "@/components/ui/icon";

/**
 * Material 3 settings list of universal `ListItem` rows. The universal Android FieldGroup wraps each
 * row in its own non-clickable ListItem, and Android ListItem ignores `testID`, hence the modifier.
 */
export function SettingsMenu({ sections }: { sections: SettingsMenuSection[] }) {
	const { theme } = useUniwind();
	const [background, foreground, muted, border] = useCSSVariable([
		"--color-background",
		"--color-foreground",
		"--color-muted-foreground",
		"--color-border",
	]);
	const color = (value: string | number | undefined) =>
		typeof value === "string" ? value : undefined;
	return (
		<Host style={{ flex: 1 }} colorScheme={theme === "dark" ? "dark" : "light"}>
			<LazyColumn modifiers={[testID("settings-menu")]}>
				{sections.map((section, index) => (
					<Fragment key={section.id}>
						{index > 0 ? <HorizontalDivider color={color(border)} /> : null}
						{section.rows.map((row) => (
							<ListItem
								key={row.id}
								onPress={row.onPress}
								modifiers={[testID(`settings-row-${row.id}`)]}
								colors={{
									containerColor: color(background),
									contentColor: color(foreground),
									supportingContentColor: color(muted),
								}}
								leading={
									<RNHostView matchContents>
										<IconChip size="sm">
											<Icon as={row.icon} />
										</IconChip>
									</RNHostView>
								}
								supportingText={
									row.description ? (
										<Text style={{ fontFamily: "Geist-Regular", fontSize: 14 }}>
											{row.description}
										</Text>
									) : undefined
								}
							>
								<Text style={{ fontFamily: "Geist-Medium", fontSize: 16 }}>{row.label}</Text>
							</ListItem>
						))}
					</Fragment>
				))}
			</LazyColumn>
		</Host>
	);
}
