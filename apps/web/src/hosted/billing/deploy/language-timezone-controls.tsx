"use client";

import { HOSTED_DEPLOY_LANGUAGE_OPTIONS, normalizeHostedDeployLanguage } from "@clawdi/shared/api";
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
		for (const raw of preferred) {
			const exact = normalizeHostedLanguage(raw);
			if (exact) return exact;
			const base = raw.toLowerCase().split("-")[0];
			const byBase = LANGUAGE_OPTIONS.find(
				(option) => option.code.toLowerCase().split("-")[0] === base,
			);
			if (byBase) return byBase.code;
		}
	} catch {
		// Ignore: fall through to the unset default.
	}
	return "";
}

const FALLBACK_TIMEZONES = [
	"UTC",
	"Africa/Johannesburg",
	"America/Chicago",
	"America/Los_Angeles",
	"America/New_York",
	"America/Sao_Paulo",
	"Asia/Dubai",
	"Asia/Hong_Kong",
	"Asia/Kolkata",
	"Asia/Shanghai",
	"Asia/Singapore",
	"Asia/Tokyo",
	"Australia/Sydney",
	"Europe/Berlin",
	"Europe/London",
	"Pacific/Auckland",
] as const;

function timezoneSort(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function isValidTimezone(value: string | null | undefined): value is string {
	if (!value) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
		return true;
	} catch {
		return false;
	}
}

function runtimeTimezones(): readonly string[] | null {
	const intl = Intl as typeof Intl & {
		supportedValuesOf?: (key: "timeZone") => string[];
	};
	if (typeof intl.supportedValuesOf !== "function") return null;
	try {
		return intl.supportedValuesOf("timeZone");
	} catch {
		return null;
	}
}

function validatedTimezones(values: readonly string[]): string[] {
	return [...new Set(values.filter(isValidTimezone))].sort(timezoneSort);
}

/**
 * Runtime IANA data with a standards-valid fallback. Passing `null` explicitly
 * exercises the fallback path; additional valid values preserve browser or
 * persisted choices omitted by a runtime's enumeration.
 */
export function supportedTimezones(
	additional: readonly string[] = [],
	runtimeValues: readonly string[] | null = runtimeTimezones(),
): string[] {
	return validatedTimezones([...(runtimeValues ?? FALLBACK_TIMEZONES), "UTC", ...additional]);
}

/** Stable initial options for SSR and the first client render. */
export function fallbackTimezones(additional: readonly string[] = []): string[] {
	return supportedTimezones(additional, null);
}

export function browserTimezone(): string {
	try {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
		return isValidTimezone(timezone) ? timezone : "";
	} catch {
		return "";
	}
}

export function mergeTimezoneOptions(
	options: readonly string[],
	additional: readonly string[],
): string[] {
	return validatedTimezones([...options, ...additional]);
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
