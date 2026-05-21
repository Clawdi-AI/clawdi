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
				className="w-full flex-1 basis-full sm:max-w-sm sm:basis-auto"
			/>
			{children}
		</div>
	);
}
