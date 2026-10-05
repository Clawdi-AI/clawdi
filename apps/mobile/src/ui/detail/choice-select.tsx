import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select";
/** Preserve the typed option value at the native menu boundary. */
export function ChoiceSelect<Value extends string | number>({
	value,
	options,
	onValueChange,
	disabled,
	triggerClassName,
}: {
	value: Value;
	options: readonly { value: Value; label: string }[];
	onValueChange: (value: Value) => void;
	disabled?: boolean;
	triggerClassName?: string;
}) {
	return (
		<Select
			value={String(value)}
			disabled={disabled}
			onValueChange={(next) => {
				const selected = options.find((option) => String(option.value) === next);
				if (selected) onValueChange(selected.value);
			}}
		>
			<SelectTrigger className={triggerClassName}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={String(option.value)}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
