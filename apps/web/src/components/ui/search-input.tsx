"use client";

import { Search, X } from "lucide-react";
import type { KeyboardEventHandler } from "react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";

/**
 * Canonical shadcn Input Group composition for dashboard search fields.
 */
export function SearchInput({
	value,
	onChange,
	placeholder = "Search…",
	name = "search",
	ariaLabel = "Search",
	className,
	autoFocus,
	onKeyDown,
	ariaKeyShortcuts,
	maxLength,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	name?: string;
	ariaLabel?: string;
	className?: string;
	autoFocus?: boolean;
	onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
	ariaKeyShortcuts?: string;
	maxLength?: number;
}) {
	return (
		<InputGroup className={className}>
			<InputGroupAddon>
				<Search />
			</InputGroupAddon>
			<InputGroupInput
				name={name}
				aria-label={ariaLabel}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				autoComplete="off"
				autoFocus={autoFocus}
				onKeyDown={onKeyDown}
				aria-keyshortcuts={ariaKeyShortcuts}
				maxLength={maxLength}
			/>
			{value ? (
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						size="icon-xs"
						onClick={() => onChange("")}
						aria-label="Clear search"
						title="Clear search"
					>
						<X />
					</InputGroupButton>
				</InputGroupAddon>
			) : null}
		</InputGroup>
	);
}
