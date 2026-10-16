import { isValidTimezone, timezoneLabel, timezonePickerCopy } from "@clawdi/shared/view";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSub,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

/** IANA zones grouped by region for a two-level native menu; "UTC" stays top-level. */
function timezoneMenuGroups(options: readonly string[]) {
	const groups = new Map<string, string[]>();
	for (const timezone of options) {
		const slash = timezone.indexOf("/");
		const region = slash > 0 ? timezone.slice(0, slash) : "";
		groups.set(region, [...(groups.get(region) ?? []), timezone]);
	}
	return [...groups.entries()];
}

/** Web's TimezoneCombobox. Hundreds of IANA zones: region submenus keep the native menu short. */
export function TimezoneCombobox({
	value,
	onValueChange,
	options,
	disabled,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: readonly string[];
	disabled?: boolean;
}) {
	const item = (zone: string) => (
		<SelectItem key={zone} value={zone} label={timezoneLabel(zone)}>
			{timezoneLabel(zone)}
		</SelectItem>
	);
	return (
		<Select
			value={value}
			disabled={disabled}
			onValueChange={(timezone) => {
				if (isValidTimezone(timezone)) onValueChange(timezone);
			}}
		>
			<SelectTrigger className="w-full">
				<SelectValue placeholder={timezonePickerCopy.placeholder} />
			</SelectTrigger>
			<SelectContent>
				{timezoneMenuGroups(options).map(([region, zones]) =>
					region ? (
						<SelectSub key={region} label={region}>
							{zones.map(item)}
						</SelectSub>
					) : (
						zones.map(item)
					),
				)}
			</SelectContent>
		</Select>
	);
}
