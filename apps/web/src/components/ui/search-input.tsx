"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Canonical search input with magnifying-glass icon + clear button.
 *
 * Used everywhere the dashboard offers a search box: list pages
 * (connectors, skills), table toolbars (`DataTableToolbar`), and
 * filtering panels in detail pages (connector tools list).
 *
 * Pulled out because the same `<div className="relative"><Search />
 * <Input pl-9 pr-9 /><X></div>` pattern was duplicated across four
 * call sites with subtle drift (icon position, clear-button size,
 * placeholder casing).
 */
export function SearchInput({
	value,
	onChange,
	placeholder = "Search…",
	className,
	autoFocus,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	className?: string;
	autoFocus?: boolean;
}) {
	return (
		<div className={cn("relative", className)}>
			<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="pl-9 pr-9"
				autoFocus={autoFocus}
			/>
			{value ? (
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() => onChange("")}
					className="-translate-y-1/2 absolute top-1/2 right-1"
					aria-label="Clear search"
				>
					<X className="size-4" />
				</Button>
			) : null}
		</div>
	);
}
