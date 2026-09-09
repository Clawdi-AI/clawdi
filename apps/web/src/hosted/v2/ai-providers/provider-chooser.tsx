"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { PROVIDER_PRESETS, type ProviderPreset } from "@/hosted/v2/ai-providers/provider-presets";
import { type ProviderTypeId, providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";

export type ProviderChoice =
	| { kind: "type"; type: ProviderTypeId }
	| { kind: "preset"; preset: ProviderPreset; regionId?: string }
	| { kind: "oauth" };

interface ChoiceEntry {
	id: string;
	label: string;
	choice: ProviderChoice;
}
interface ProviderGroup {
	id: string;
	label: string;
	iconId: string;
	entries: ChoiceEntry[];
}

function typeGroup(type: ProviderTypeId): ProviderGroup {
	const label =
		type === "custom_openai_compatible" ? "Custom endpoint" : providerTypeMeta(type).label;
	return {
		id: type,
		label,
		iconId: type,
		entries: [{ id: type, label, choice: { kind: "type", type } }],
	};
}

const GROUPS: ProviderGroup[] = [
	{
		id: "openai",
		label: "OpenAI",
		iconId: "openai",
		entries: [
			{ id: "openai-api", label: "OpenAI API", choice: { kind: "type", type: "openai" } },
			{ id: "chatgpt-codex", label: "ChatGPT (Codex)", choice: { kind: "oauth" } },
		],
	},
	typeGroup("anthropic"),
	typeGroup("gemini"),
];
for (const preset of PROVIDER_PRESETS) {
	const isKimi = preset.id === "moonshot" || preset.id === "kimi-coding";
	const id = isKimi ? "kimi" : preset.id;
	let group = GROUPS.find((item) => item.id === id);
	if (!group) {
		group = { id, label: isKimi ? "Kimi" : preset.label, iconId: preset.id, entries: [] };
		GROUPS.push(group);
	}
	const regions = preset.region_variants ?? [];
	group.entries.push(
		...(regions.length
			? regions.map((region) => ({
					id: `${preset.id}:${region.id}`,
					label: isKimi ? `API · ${region.label}` : region.label,
					choice: { kind: "preset" as const, preset, regionId: region.id },
				}))
			: [
					{
						id: preset.id,
						label: isKimi ? "Kimi Code" : preset.label,
						choice: { kind: "preset" as const, preset },
					},
				]),
	);
}
GROUPS.push(typeGroup("custom_openai_compatible"));

export function ProviderChooser({ onSelect }: { onSelect: (choice: ProviderChoice) => void }) {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<ProviderGroup | null>(null);
	const normalized = query.trim().toLowerCase();
	const groups = GROUPS.filter((group) =>
		[group.id, group.label, ...group.entries.map((entry) => `${entry.id} ${entry.label}`)]
			.join(" ")
			.toLowerCase()
			.includes(normalized),
	);
	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-3">
			{selected ? (
				<>
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Back to providers"
							onClick={() => setSelected(null)}
						>
							<ArrowLeft />
						</Button>
						<EntityIcon kind="provider" id={selected.iconId} size="sm" />
						<span className="text-sm font-medium">{selected.label}</span>
					</div>
					<div className="grid gap-2 sm:grid-cols-2" data-testid="provider-variant-grid">
						{selected.entries.map((entry) => (
							<Button
								key={entry.id}
								variant="outline"
								className="h-auto min-h-11 justify-between whitespace-normal px-3 py-2 text-left"
								onClick={() => onSelect(entry.choice)}
							>
								{entry.label}
								<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							</Button>
						))}
					</div>
				</>
			) : (
				<>
					<SearchInput
						name="provider-search"
						ariaLabel="Search providers"
						value={query}
						onChange={setQuery}
						placeholder="Search providers…"
					/>
					<div data-testid="provider-choice-grid" className="grid grid-cols-2 gap-2">
						{groups.map((group) => (
							<Button
								key={group.id}
								variant="outline"
								className="h-11 min-w-0 justify-start gap-2 px-3 text-left"
								onClick={() => {
									const first = group.entries[0];
									if (group.entries.length === 1 && first) onSelect(first.choice);
									else setSelected(group);
								}}
							>
								<span aria-hidden="true" className="shrink-0">
									<EntityIcon kind="provider" id={group.iconId} size="sm" />
								</span>
								<span className="min-w-0 flex-1 truncate">{group.label}</span>
								{group.entries.length > 1 ? (
									<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
								) : null}
							</Button>
						))}
					</div>
					{!groups.length ? (
						<div className="flex flex-col items-start gap-2">
							<p className="text-sm text-muted-foreground">No providers found</p>
							<Button
								variant="outline"
								onClick={() => onSelect({ kind: "type", type: "custom_openai_compatible" })}
							>
								Use a custom endpoint
							</Button>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
