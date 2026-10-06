import { providerChooserClasses as styles } from "@clawdi/shared/ui";
import {
	providerChooserCopy as copy,
	filterProviderGroups,
	type ProviderChoice,
	type ProviderGroup,
} from "@clawdi/shared/view";
import { Stack, useNavigation } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useEffect, useState } from "react";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useHeaderSearch } from "@/platform/navigation/native-header";

/** Native rendering of Web's provider chooser, sharing its catalog and recipes. */
export function ProviderChooser({
	onSelect,
	selected,
	onGroupChange,
}: {
	onSelect: (choice: ProviderChoice) => void;
	selected: ProviderGroup | null;
	onGroupChange: (group: ProviderGroup | null) => void;
}) {
	const navigation = useNavigation();
	useEffect(() => () => navigation.setOptions({ headerSearchBarOptions: undefined }), [navigation]);
	const [query, setQuery] = useState("");
	const groups = filterProviderGroups(query);
	const search = useHeaderSearch({
		value: query,
		onChange: setQuery,
		placeholder: copy.searchPlaceholder,
		maxLength: 256,
	});
	const entries = selected?.entries ?? [];
	return (
		<>
			<Stack.Screen options={{ headerSearchBarOptions: selected ? undefined : search }} />
			{selected ? (
				<NativeList
					data={entries}
					keyExtractor={(entry) => entry.id}
					renderItem={({ item: entry }) => (
						<Button
							variant="outline"
							className={webBoth(styles.variant)}
							onPress={() => onSelect(entry.choice)}
						>
							<Text>{entry.label}</Text>
							<Icon as={ChevronRight} className={webBoth(styles.chevron)} />
						</Button>
					)}
				/>
			) : (
				<NativeList
					key="groups"
					data={groups}
					numColumns={2}
					keyExtractor={(group) => group.id}
					columnWrapperStyle={{ gap: 8 }}
					renderItem={({ item: group }) => (
						<Button
							variant="outline"
							className={`${webView(styles.choice)} flex-1`}
							onPress={() => {
								const first = group.entries[0];
								if (group.entries.length === 1 && first) onSelect(first.choice);
								else onGroupChange(group);
							}}
						>
							<EntityIcon kind="provider" id={group.iconId} label={group.label} size="sm" />
							<Text numberOfLines={1} className={webBoth(styles.label)}>
								{group.label}
							</Text>
							{group.entries.length > 1 ? (
								<Icon as={ChevronRight} className={webBoth(styles.chevron)} />
							) : null}
						</Button>
					)}
					empty={
						<WebView recipe={styles.empty}>
							<WebText recipe={styles.hint}>{copy.noResults}</WebText>
							<Button
								variant="outline"
								onPress={() => onSelect({ kind: "type", type: "custom_openai_compatible" })}
							>
								<Text>{copy.customEndpoint}</Text>
							</Button>
						</WebView>
					}
				/>
			)}
		</>
	);
}
