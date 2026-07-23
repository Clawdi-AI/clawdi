"use client";

import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { modelChoiceOptions } from "@/hosted/v2/ai-providers/model-binding";

export function CatalogModelSelect({
	id,
	modelIds,
	value,
	onValueChange,
	formatModelLabel,
}: {
	id: string;
	modelIds: readonly string[];
	value: string;
	onValueChange: (value: string) => void;
	formatModelLabel?: (model: string) => string;
}) {
	const items = modelChoiceOptions(modelIds, formatModelLabel);

	return (
		<Select
			items={items}
			value={value}
			onValueChange={(nextValue) => {
				if (nextValue) onValueChange(nextValue);
			}}
		>
			<SelectTrigger id={id} className="w-full" data-hosted="true" data-v2="true">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}
