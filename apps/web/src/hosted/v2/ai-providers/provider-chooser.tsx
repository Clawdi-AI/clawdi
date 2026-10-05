"use client";

import {
	providerChooserCopy as copy,
	filterProviderGroups,
	type ProviderChoice,
	type ProviderGroup,
} from "@clawdi/shared/view";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";

export type { ProviderChoice, ProviderGroup } from "@clawdi/shared/view";

import { providerChooserClasses as styles } from "@clawdi/shared/ui";

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
		<div data-hosted="true" data-v2="true" className={styles.root}>
			{selected ? (
				<div className={styles.variants} data-testid="provider-variant-grid">
					{selected.entries.map((entry) => (
						<Button
							key={entry.id}
							variant="outline"
							className={styles.variant}
							onClick={() => onSelect(entry.choice)}
						>
							{entry.label}
							<ChevronRight className={styles.chevron} />
						</Button>
					))}
				</div>
			) : (
				<>
					<SearchInput
						name="provider-search"
						ariaLabel={copy.searchLabel}
						value={query}
						onChange={setQuery}
						placeholder={copy.searchPlaceholder}
					/>
					<div data-testid="provider-choice-grid" className={styles.choices}>
						{groups.map((group) => (
							<Button
								key={group.id}
								variant="outline"
								className={styles.choice}
								onClick={() => {
									const first = group.entries[0];
									if (group.entries.length === 1 && first) onSelect(first.choice);
									else onGroupChange(group);
								}}
							>
								<span aria-hidden="true" className={styles.icon}>
									<EntityIcon kind="provider" id={group.iconId} size="sm" />
								</span>
								<span className={styles.label}>{group.label}</span>
								{group.entries.length > 1 ? <ChevronRight className={styles.chevron} /> : null}
							</Button>
						))}
					</div>
					{!groups.length ? (
						<div className={styles.empty}>
							<p className={styles.hint}>{copy.noResults}</p>
							<Button
								variant="outline"
								onClick={() => onSelect({ kind: "type", type: "custom_openai_compatible" })}
							>
								{copy.customEndpoint}
							</Button>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
