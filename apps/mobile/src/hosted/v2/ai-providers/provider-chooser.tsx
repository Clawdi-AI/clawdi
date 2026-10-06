import { providerChooserClasses as styles } from "@clawdi/shared/ui";
import {
	providerChooserCopy as copy,
	filterProviderGroups,
	type ProviderChoice,
	type ProviderGroup,
} from "@clawdi/shared/view";
import { ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";

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
	const [query, setQuery] = useState("");
	const groups = filterProviderGroups(query);
	return (
		<WebView recipe={styles.root}>
			{selected ? (
				<WebView recipe={styles.variants}>
					{selected.entries.map((entry) => (
						<Button
							key={entry.id}
							variant="outline"
							className={webBoth(styles.variant)}
							onPress={() => onSelect(entry.choice)}
						>
							<Text>{entry.label}</Text>
							<Icon as={ChevronRight} className={webBoth(styles.chevron)} />
						</Button>
					))}
				</WebView>
			) : (
				<>
					<SearchInput
						ariaLabel={copy.searchLabel}
						value={query}
						onChange={setQuery}
						placeholder={copy.searchPlaceholder}
					/>
					<WebView recipe={styles.choices}>
						{Array.from({ length: Math.ceil(groups.length / 2) }, (_, rowIndex) =>
							groups.slice(rowIndex * 2, rowIndex * 2 + 2),
						).map((row) => (
							<WebView
								key={row.map((group) => group.id).join(":")}
								recipe={styles.choices}
								className="flex-row"
							>
								{row.map((group) => (
									<Button
										key={group.id}
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
								))}
								{row.length === 1 ? <WebView recipe="" className="flex-1" /> : null}
							</WebView>
						))}
					</WebView>
					{!groups.length ? (
						<WebView recipe={styles.empty}>
							<WebText recipe={styles.hint}>{copy.noResults}</WebText>
							<Button
								variant="outline"
								onPress={() => onSelect({ kind: "type", type: "custom_openai_compatible" })}
							>
								<Text>{copy.customEndpoint}</Text>
							</Button>
						</WebView>
					) : null}
				</>
			)}
		</WebView>
	);
}
