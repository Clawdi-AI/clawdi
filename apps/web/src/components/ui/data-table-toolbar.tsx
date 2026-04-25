"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
			<div className="relative max-w-sm flex-1">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					className="pr-8 pl-9"
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
			{children}
		</div>
	);
}
