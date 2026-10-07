import { FieldGroup, Host } from "@expo/ui";
import { Button, HStack, Image, RNHostView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { buttonStyle, contentShape, foregroundStyle, shapes } from "@expo/ui/swift-ui/modifiers";
import type { LucideIcon } from "lucide-react-native";
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

/**
 * iOS grouped settings list: `@expo/ui` FieldGroup renders SwiftUI `Form` sections. Rows mirror the
 * universal ListItem's plain `Button` layout; it wraps every accessory in RNHostView, so the native
 * disclosure chevron is composed here.
 */
export function SettingsMenu({ sections }: { sections: SettingsMenuSection[] }) {
	const { theme } = useUniwind();
	return (
		<Host style={{ flex: 1 }} colorScheme={theme === "dark" ? "dark" : "light"}>
			<FieldGroup testID="settings-menu">
				{sections.map((section) => (
					<FieldGroup.Section key={section.id}>
						{section.rows.map((row) => (
							<Button
								key={row.id}
								testID={`settings-row-${row.id}`}
								onPress={row.onPress}
								modifiers={[buttonStyle("plain")]}
							>
								<HStack spacing={12} modifiers={[contentShape(shapes.rectangle())]}>
									<RNHostView matchContents>
										<IconChip size="sm">
											<Icon as={row.icon} />
										</IconChip>
									</RNHostView>
									<VStack alignment="leading" spacing={2}>
										<Text>{row.label}</Text>
										{row.description ? (
											<Text
												modifiers={[foregroundStyle({ type: "hierarchical", style: "secondary" })]}
											>
												{row.description}
											</Text>
										) : null}
									</VStack>
									<Spacer />
									<Image
										systemName="chevron.right"
										size={13}
										modifiers={[foregroundStyle({ type: "hierarchical", style: "tertiary" })]}
									/>
								</HStack>
							</Button>
						))}
					</FieldGroup.Section>
				))}
			</FieldGroup>
		</Host>
	);
}
