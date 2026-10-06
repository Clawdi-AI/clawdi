import { accountAliasFieldClasses } from "@clawdi/shared/ui";
import { connectorFormCopy as copy } from "@clawdi/shared/view";
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
		<div className={accountAliasFieldClasses.field}>
			<Label htmlFor={id}>{copy.name}</Label>
			<Input
				id={id}
				value={value}
				maxLength={256}
				onChange={(event) => onChange(event.target.value)}
				disabled={disabled}
				placeholder={copy.namePlaceholder}
				autoComplete="off"
				spellCheck={false}
				aria-describedby={`${id}-hint`}
			/>
			<p id={`${id}-hint`} className={accountAliasFieldClasses.hint}>
				{copy.nameHint}
			</p>
		</div>
	);
}
