"use client";

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

/** Common UI languages offered during onboarding and hosted runtime settings. */
export const LANGUAGE_OPTIONS = [
	{ code: "en", label: "English" },
	{ code: "zh-CN", label: "简体中文" },
	{ code: "zh-TW", label: "繁體中文" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "es", label: "Español" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" },
	{ code: "pt", label: "Português" },
] as const;

export function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	} catch {
		return "";
	}
}

export function supportedTimezones(): string[] {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [];
	}
}

function timezoneLabel(timezone: string): string {
	return timezone.replaceAll("_", " ");
}

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
				<PopoverTrigger asChild>
					<Button
						id={id}
						type="button"
						variant="outline"
						role="combobox"
						aria-expanded={open}
						className="w-full justify-between"
					>
						<span className={cn("truncate", !value && "text-muted-foreground")}>
							{value ? timezoneLabel(value) : "Select a timezone"}
						</span>
						<ChevronsUpDown className="opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
					<Command>
						<CommandInput placeholder="Search timezones…" />
						<CommandList className="max-h-72">
							<CommandEmpty>No timezone found.</CommandEmpty>
							<CommandGroup>
								{options.map((tz) => {
									const selected = value === tz;
									const label = timezoneLabel(tz);
									return (
										<CommandItem
											key={tz}
											value={tz}
											keywords={[label, tz.replaceAll("/", " ")]}
											onSelect={() => {
												onValueChange(tz);
												setOpen(false);
											}}
										>
											<Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
											<span className="truncate">{label}</span>
											{label !== tz ? (
												<span className="ml-auto truncate text-xs text-muted-foreground">{tz}</span>
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
