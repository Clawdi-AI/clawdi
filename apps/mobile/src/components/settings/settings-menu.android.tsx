import {
	HorizontalDivider,
	Host,
	LazyColumn,
	ListItem,
	RNHostView,
	Text,
} from "@expo/ui/jetpack-compose";
import { clickable, testID } from "@expo/ui/jetpack-compose/modifiers";
import { Fragment } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import { IconChip } from "@/components/icon-chip";
import type { SettingsMenuSection } from "@/components/settings/settings-menu";
import { Icon } from "@/components/ui/icon";

/** Material 3 settings list: Compose `ListItem` rows; the universal FieldGroup cannot host tappable rows. */
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
								colors={{
									containerColor: color(background),
									contentColor: color(foreground),
									supportingContentColor: color(muted),
								}}
								modifiers={[clickable(row.onPress), testID(`settings-row-${row.id}`)]}
							>
								<ListItem.LeadingContent>
									<RNHostView matchContents>
										<IconChip size="sm">
											<Icon as={row.icon} />
										</IconChip>
									</RNHostView>
								</ListItem.LeadingContent>
								<ListItem.HeadlineContent>
									<Text style={{ fontFamily: "Geist-Medium", fontSize: 16 }}>{row.label}</Text>
								</ListItem.HeadlineContent>
								{row.description ? (
									<ListItem.SupportingContent>
										<Text style={{ fontFamily: "Geist-Regular", fontSize: 14 }}>
											{row.description}
										</Text>
									</ListItem.SupportingContent>
								) : null}
							</ListItem>
						))}
					</Fragment>
				))}
			</LazyColumn>
		</Host>
	);
}
