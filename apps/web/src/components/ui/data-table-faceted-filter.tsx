"use client";

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
export interface FacetedFilterOption {
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
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 border-dashed">
					<PlusCircleIcon className="size-4" />
					{title}
					{selected.length > 0 && (
						<>
							<Separator orientation="vertical" className="mx-2 h-4" />
							<Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
								{selected.length}
							</Badge>
							<div className="hidden gap-1 lg:flex">
								{selected.length > 2 ? (
									<Badge variant="secondary" className="rounded-sm px-1 font-normal">
										{selected.length} selected
									</Badge>
								) : (
									options
										.filter((option) => selectedSet.has(option.value))
										.map((option) => (
											<Badge
												key={option.value}
												variant="secondary"
												className="rounded-sm px-1 font-normal"
											>
												{option.label}
											</Badge>
										))
								)}
							</div>
						</>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0" align="start">
				<Command>
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
												"mr-2 flex size-4 items-center justify-center rounded-sm border border-primary",
												isSelected
													? "bg-primary text-primary-foreground"
													: "opacity-50 [&_svg]:invisible",
											)}
										>
											<CheckIcon className="size-3" />
										</div>
										{option.icon ? (
											<option.icon className="mr-2 size-4 text-muted-foreground" />
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
									<CommandItem onSelect={() => onChange([])} className="justify-center text-center">
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
