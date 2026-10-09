"use client";

import { HOSTED_DEPLOY_LANGUAGE_OPTIONS, normalizeHostedDeployLanguage } from "@clawdi/shared/api";
import {
	fallbackTimezones,
	hostedDeployLanguageFromLocales,
	mergeTimezoneOptions,
	resolvedTimezone,
	supportedTimezones,
	timezoneLabel,
} from "@clawdi/shared/view";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Curated languages supported by the hosted deployment contract. */
export const LANGUAGE_OPTIONS = HOSTED_DEPLOY_LANGUAGE_OPTIONS;

export type HostedLanguage = (typeof LANGUAGE_OPTIONS)[number]["code"];

export const LANGUAGE_SELECT_ITEMS = [
	{ value: "default", label: "Default" },
	...LANGUAGE_OPTIONS.map((option) => ({ value: option.code, label: option.label })),
] as const;

export function normalizeHostedLanguage(value: string | null | undefined): HostedLanguage | null {
	return normalizeHostedDeployLanguage(value);
}

/**
 * Best-effort map of browser preferences onto the curated hosted contract.
 * Client-only (reads navigator); call after mount.
 */
export function browserLanguage(): HostedLanguage | "" {
	try {
		const preferred =
			typeof navigator !== "undefined"
				? (navigator.languages?.length ? navigator.languages : [navigator.language]).filter(Boolean)
				: [];
		return hostedDeployLanguageFromLocales(preferred);
	} catch {
		// Ignore: fall through to the unset default.
	}
	return "";
}

export {
	fallbackTimezones,
	mergeTimezoneOptions,
	resolvedTimezone as browserTimezone,
	supportedTimezones,
};

export function TimezoneCombobox({
	id = "agent-timezone",
	value,
	onValueChange,
	options,
}: {
	id?: string;
	value: string;
	onValueChange: (value: string) => void;
	options: string[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<div data-hosted="true" className="contents">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							id={id}
							type="button"
							variant="outline"
							role="combobox"
							aria-expanded={open}
							className="w-full justify-between"
						/>
					}
				>
					<span className={cn("truncate", !value && "text-muted-foreground")}>
						{value ? timezoneLabel(value) : "Select a timezone"}
					</span>
					<ChevronsUpDown className="opacity-50" />
				</PopoverTrigger>
				<PopoverContent align="start" className="w-(--anchor-width) p-0">
					<Command label="Timezone options">
						<CommandInput placeholder="Search timezones…" />
						<CommandList className="max-h-72">
							<CommandEmpty>No timezone found.</CommandEmpty>
							<CommandGroup>
								{options.map((timezone) => {
									const selected = value === timezone;
									const label = timezoneLabel(timezone);
									return (
										<CommandItem
											key={timezone}
											value={timezone}
											keywords={[label, timezone.replaceAll("/", " ")]}
											onSelect={() => {
												onValueChange(timezone);
												setOpen(false);
											}}
										>
											<Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
											<span className="truncate">{label}</span>
											{label !== timezone ? (
												<span className="ml-auto truncate text-xs text-muted-foreground">
													{timezone}
												</span>
											) : null}
										</CommandItem>
									);
								})}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}
