import { FieldGroup, Host, ListItem } from "@expo/ui";
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { useUniwind } from "uniwind";
import { IconChip } from "@/components/icon-chip";
import { Icon } from "@/components/ui/icon";

export type SettingsMenuRow = {
	id: string;
	label: string;
	description?: string;
	icon: LucideIcon;
	onPress: () => void;
};
export type SettingsMenuSection = { id: string; rows: SettingsMenuRow[] };

/** iOS grouped settings list: `@expo/ui` FieldGroup renders SwiftUI `Form` sections. */
export function SettingsMenu({ sections }: { sections: SettingsMenuSection[] }) {
	const { theme } = useUniwind();
	return (
		<Host style={{ flex: 1 }} colorScheme={theme === "dark" ? "dark" : "light"}>
			<FieldGroup testID="settings-menu">
				{sections.map((section) => (
					<FieldGroup.Section key={section.id}>
						{section.rows.map((row) => (
							<ListItem
								key={row.id}
								testID={`settings-row-${row.id}`}
								onPress={row.onPress}
								supportingText={row.description}
								leading={
									<IconChip size="sm">
										<Icon as={row.icon} />
									</IconChip>
								}
								trailing={<Icon as={ChevronRight} className="text-muted-foreground" />}
							>
								{row.label}
							</ListItem>
						))}
					</FieldGroup.Section>
				))}
			</FieldGroup>
		</Host>
	);
}
