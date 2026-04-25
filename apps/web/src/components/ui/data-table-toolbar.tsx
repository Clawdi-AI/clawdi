"use client";

import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";

interface Props {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	className?: string;
	children?: React.ReactNode;
}

export function DataTableToolbar({
	value,
	onChange,
	placeholder = "Search…",
	className,
	children,
}: Props) {
	return (
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			<SearchInput
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				className="max-w-sm flex-1"
			/>
			{children}
		</div>
	);
}
