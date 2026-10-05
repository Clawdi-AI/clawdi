"use client";

import { dataTableFacetedFilterClasses } from "@clawdi/shared/ui";

import { CheckIcon, PlusCircleIcon } from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Faceted filter button following the canonical shadcn data-table
 * example (https://ui.shadcn.com/examples/tasks). Sits in the
 * table's toolbar; clicking opens a command-palette-style popover
 * with searchable, multi-select filter options.
 *
 * For our session list usage we wire it as a single-select (date
 * preset / agent) by passing a single-value setter; the underlying
 * shape supports multi-select for future use.
 */
interface FacetedFilterOption {
	label: string;
	value: string;
	icon?: React.ComponentType<{ className?: string }>;
}

interface Props {
	title: string;
	options: FacetedFilterOption[];
	/** Selected value(s). Pass an array even for single-select. */
	selected: string[];
	onChange: (selected: string[]) => void;
	/** When false, only one option can be active at a time
	 * (clicking a different one replaces the selection). */
	multi?: boolean;
}

export function DataTableFacetedFilter({
	title,
	options,
	selected,
	onChange,
	multi = false,
}: Props) {
	const selectedSet = new Set(selected);

	return (
		<Popover>
			<PopoverTrigger render={<Button variant="outline" size="sm" className={dataTableFacetedFilterClasses.trigger} />}>
				<PlusCircleIcon className={dataTableFacetedFilterClasses.triggerIcon} />
				{title}
				{selected.length > 0 && (
					<>
						<Separator orientation="vertical" className={dataTableFacetedFilterClasses.separator} />
						<Badge variant="secondary" className={dataTableFacetedFilterClasses.selectedCount}>
							{selected.length}
						</Badge>
						<div className={dataTableFacetedFilterClasses.selectedLabels}>
							{selected.length > 2 ? (
								<Badge variant="secondary" className={dataTableFacetedFilterClasses.selectedBadge}>
									{selected.length} selected
								</Badge>
							) : (
								options
									.filter((option) => selectedSet.has(option.value))
									.map((option) => (
										<Badge
											key={option.value}
											variant="secondary"
											className={dataTableFacetedFilterClasses.selectedBadge}
										>
											{option.label}
										</Badge>
									))
							)}
						</div>
					</>
				)}
			</PopoverTrigger>
			<PopoverContent className={dataTableFacetedFilterClasses.content} align="start">
				<Command label={`${title} filter options`}>
					<CommandInput placeholder={title} />
					<CommandList>
						<CommandEmpty>No results found.</CommandEmpty>
						<CommandGroup>
							{options.map((option) => {
								const isSelected = selectedSet.has(option.value);
								return (
									<CommandItem
										key={option.value}
										onSelect={() => {
											if (multi) {
												const next = new Set(selectedSet);
												if (isSelected) next.delete(option.value);
												else next.add(option.value);
												onChange(Array.from(next));
											} else {
												onChange(isSelected ? [] : [option.value]);
											}
										}}
									>
										<div
											className={cn(
												dataTableFacetedFilterClasses.checkbox,
												isSelected
													? dataTableFacetedFilterClasses.checked
													: dataTableFacetedFilterClasses.unchecked,
											)}
										>
											<CheckIcon className={dataTableFacetedFilterClasses.checkIcon} />
										</div>
										{option.icon ? (
											<option.icon className={dataTableFacetedFilterClasses.optionIcon} />
										) : null}
										<span>{option.label}</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
						{selected.length > 0 && (
							<>
								<CommandSeparator />
								<CommandGroup>
									<CommandItem onSelect={() => onChange([])} className={dataTableFacetedFilterClasses.clearAction}>
										Clear filter
									</CommandItem>
								</CommandGroup>
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
