"use client";

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { SearchInput } from "@/components/ui/search-input";
import {
	PROVIDER_PRESET_CATEGORIES,
	PROVIDER_PRESET_CATEGORY_LABEL,
	PROVIDER_PRESETS,
	type ProviderPreset,
} from "@/hosted/v2/ai-providers/provider-presets";
import {
	API_MODE_LABEL,
	type ProviderTypeId,
	providerTypeMeta,
} from "@/hosted/v2/ai-providers/provider-types";

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
const POPULAR_IDS = new Set([
	"type:openai",
	"type:anthropic",
	"preset:openrouter",
	"type:gemini",
	"preset:deepseek",
	"preset:moonshot",
	"type:custom_openai_compatible",
]);

function typeDescription(type: ProviderTypeId): string {
	if (type === "openai") return "API key or ChatGPT sign-in";
	if (type === "anthropic") return "Claude models";
	if (type === "gemini") return "Google GenerateContent";
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
	const category = PROVIDER_PRESET_CATEGORY_LABEL[preset.category];
	return {
		id: `preset:${preset.id}`,
		label: preset.label,
		description: `${API_MODE_LABEL[preset.api_mode]} · ${preset.catalog.length} models`,
		iconId: preset.id,
		searchText: `${preset.label} ${preset.id} ${category} ${preset.api_mode}`.toLowerCase(),
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
		<div className="grid gap-2 sm:grid-cols-2">
			{entries.map((entry) => (
				<EntityChoiceCard
					key={entry.id}
					onClick={() => onSelect(entry.choice)}
					icon={<EntityIcon kind="provider" id={entry.iconId} label={entry.label} size="sm" />}
					title={entry.label}
					description={entry.description}
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
	const popular = ALL_ENTRIES.filter((entry) => POPULAR_IDS.has(entry.id));

	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-4">
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
						/>
					)}
				</div>
			) : (
				<>
					<div className="flex flex-col gap-2">
						<p className="text-xs font-medium text-muted-foreground">Popular</p>
						<ChoiceGrid entries={popular} onSelect={onSelect} />
					</div>
					<details className="group rounded-lg border bg-muted/20">
						<summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium marker:hidden">
							Browse all providers
							<ChevronDown
								className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
								aria-hidden
							/>
						</summary>
						<div className="flex flex-col gap-4 border-t px-3 py-3">
							{PROVIDER_PRESET_CATEGORIES.map((category) => {
								const entries = ALL_ENTRIES.filter(
									(entry) =>
										entry.choice.kind === "preset" && entry.choice.preset.category === category,
								);
								if (entries.length === 0) return null;
								return (
									<div key={category} className="flex flex-col gap-1.5">
										<p className="text-xs font-medium text-muted-foreground">
											{PROVIDER_PRESET_CATEGORY_LABEL[category]}
										</p>
										<ChoiceGrid entries={entries} onSelect={onSelect} />
									</div>
								);
							})}
						</div>
					</details>
				</>
			)}
		</div>
	);
}
