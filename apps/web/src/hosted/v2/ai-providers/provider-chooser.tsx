"use client";

import { useMemo, useState } from "react";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { SearchInput } from "@/components/ui/search-input";
import { providerPresetSummary } from "@/hosted/v2/ai-providers/model-binding";
import { PROVIDER_PRESETS, type ProviderPreset } from "@/hosted/v2/ai-providers/provider-presets";
import { type ProviderTypeId, providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";

export type ProviderChoice =
	| { kind: "type"; type: ProviderTypeId }
	| { kind: "preset"; preset: ProviderPreset };

interface ChoiceEntry {
	id: string;
	label: string;
	description: string;
	iconId: string;
	searchText: string;
	choice: ProviderChoice;
}

const FIRST_CLASS_TYPES: readonly ProviderTypeId[] = ["openai", "anthropic", "gemini"];
function typeDescription(type: ProviderTypeId): string {
	if (type === "openai") return "API key or ChatGPT sign-in";
	if (type === "anthropic") return "Claude model access";
	if (type === "gemini") return "Gemini model access";
	return "Bring any OpenAI-compatible endpoint";
}

function typeEntry(type: ProviderTypeId): ChoiceEntry {
	const meta = providerTypeMeta(type);
	return {
		id: `type:${type}`,
		label: type === "custom_openai_compatible" ? "Custom endpoint" : meta.label,
		description: typeDescription(type),
		iconId: type,
		searchText: `${meta.label} ${type} ${typeDescription(type)}`.toLowerCase(),
		choice: { kind: "type", type },
	};
}

function presetEntry(preset: ProviderPreset): ChoiceEntry {
	const description = providerPresetSummary(preset);
	return {
		id: `preset:${preset.id}`,
		label: preset.label,
		description,
		iconId: preset.id,
		searchText: [
			preset.label,
			preset.id,
			preset.api_mode,
			description,
			...preset.catalog.flatMap((model) => [model.id, model.alias ?? ""]),
		]
			.join(" ")
			.toLowerCase(),
		choice: { kind: "preset", preset },
	};
}

const ALL_ENTRIES: readonly ChoiceEntry[] = [
	...FIRST_CLASS_TYPES.map(typeEntry),
	...PROVIDER_PRESETS.map(presetEntry),
	typeEntry("custom_openai_compatible"),
];

function ChoiceGrid({
	entries,
	onSelect,
}: {
	entries: readonly ChoiceEntry[];
	onSelect: (choice: ProviderChoice) => void;
}) {
	return (
		<div data-testid="provider-choice-grid" className="grid gap-1.5 sm:grid-cols-2">
			{entries.map((entry) => (
				<EntityChoiceCard
					key={entry.id}
					onClick={() => onSelect(entry.choice)}
					icon={<EntityIcon kind="provider" id={entry.iconId} label={entry.label} size="sm" />}
					title={entry.label}
					description={entry.description}
					variant="compact"
				/>
			))}
		</div>
	);
}

export function ProviderChooser({ onSelect }: { onSelect: (choice: ProviderChoice) => void }) {
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();
	const searchResults = useMemo(
		() =>
			normalizedQuery
				? ALL_ENTRIES.filter((entry) => entry.searchText.includes(normalizedQuery))
				: [],
		[normalizedQuery],
	);
	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-3">
			<SearchInput
				name="provider-search"
				ariaLabel="Search providers"
				value={query}
				onChange={setQuery}
				placeholder="OpenAI, DeepSeek, Moonshot…"
			/>

			{normalizedQuery ? (
				<div className="flex flex-col gap-2">
					<p className="text-xs font-medium text-muted-foreground">
						{searchResults.length > 0 ? `${searchResults.length} matches` : "No providers found"}
					</p>
					{searchResults.length > 0 ? (
						<ChoiceGrid entries={searchResults} onSelect={onSelect} />
					) : (
						<div data-testid="provider-choice-grid" className="grid gap-1.5 sm:grid-cols-2">
							<EntityChoiceCard
								onClick={() => onSelect({ kind: "type", type: "custom_openai_compatible" })}
								icon={
									<EntityIcon
										kind="provider"
										id="custom_openai_compatible"
										label="Custom endpoint"
										size="sm"
									/>
								}
								title="Use a custom endpoint"
								description={`No matches for “${query.trim()}”. Configure it manually.`}
								variant="compact"
							/>
						</div>
					)}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<p className="text-xs font-medium text-muted-foreground">Providers</p>
					<ChoiceGrid entries={ALL_ENTRIES} onSelect={onSelect} />
				</div>
			)}
		</div>
	);
}
