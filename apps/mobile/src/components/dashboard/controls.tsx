import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Text } from "@/components/ui/text";
export function ActionButton({
	label,
	icon,
	onPress,
	disabled,
	variant = "outline",
	className,
}: {
	label: string;
	icon?: ReactNode;
	onPress: () => void;
	disabled?: boolean;
	variant?: "default" | "outline" | "ghost" | "destructive";
	className?: string;
}) {
	return (
		<Button size="sm" variant={variant} onPress={onPress} disabled={disabled} className={className}>
			{icon}
			<Text>{label}</Text>
		</Button>
	);
}
export function ChoiceSelect<Value extends string | number>({
	value,
	options,
	onValueChange,
	disabled,
}: {
	value: Value;
	options: readonly { value: Value; label: string }[];
	onValueChange: (value: Value) => void;
	disabled?: boolean;
}) {
	return (
		<Select
			value={String(value)}
			disabled={disabled}
			onValueChange={(selected) => {
				const option = options.find((item) => String(item.value) === selected);
				if (option) onValueChange(option.value);
			}}
		>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((item) => (
					<SelectItem key={String(item.value)} value={String(item.value)} label={item.label}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
