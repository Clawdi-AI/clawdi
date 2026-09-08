import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AccountAliasField({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>Account alias (optional)</Label>
			<Input
				id={id}
				value={value}
				maxLength={256}
				onChange={(event) => onChange(event.target.value)}
				disabled={disabled}
				placeholder="e.g. work-gmail"
				autoComplete="off"
				spellCheck={false}
				aria-describedby={`${id}-hint`}
			/>
			<p id={`${id}-hint`} className="text-xs text-muted-foreground">
				Use a unique alias for each of your accounts in this connector. Leave blank for no alias.
			</p>
		</div>
	);
}
