import { Button, Host, Picker, Switch } from "@expo/ui";
import type { ReactNode } from "react";

function NativeControlHost({ children }: { children: ReactNode }) {
	return (
		<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
			{children}
		</Host>
	);
}

export function NativeButton({
	disabled,
	label,
	onPress,
}: {
	disabled?: boolean;
	label: string;
	onPress: () => void;
}) {
	return (
		<NativeControlHost>
			<Button disabled={disabled} label={label} onPress={onPress} />
		</NativeControlHost>
	);
}

export function NativePicker<Value extends string | number>({
	value,
	options,
	onValueChange,
	disabled = false,
}: {
	value: Value;
	options: readonly { value: Value; label: string }[];
	onValueChange: (value: Value) => void;
	disabled?: boolean;
}) {
	return (
		<NativeControlHost>
			<Picker
				appearance="menu"
				selectedValue={value}
				enabled={!disabled}
				onValueChange={(selected) => {
					if (options.some((option) => option.value === selected)) onValueChange(selected);
				}}
			>
				{options.map((option) => (
					<Picker.Item key={option.value} value={option.value} label={option.label} />
				))}
			</Picker>
		</NativeControlHost>
	);
}

export function NativeSwitch({
	value,
	onValueChange,
	label,
	disabled = false,
}: {
	value: boolean;
	onValueChange: (value: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<NativeControlHost>
			<Switch value={value} onValueChange={onValueChange} label={label} disabled={disabled} />
		</NativeControlHost>
	);
}
