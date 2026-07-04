"use client";

import { ListToolbar } from "@/components/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";

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
		<ListToolbar
			className={className}
			search={<SearchInput value={value} onChange={onChange} placeholder={placeholder} />}
			filters={children}
		/>
	);
}
