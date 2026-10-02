import { Button } from "@expo/ui";

export function NativeButton({
	disabled,
	label,
	onPress,
}: {
	disabled?: boolean;
	label: string;
	onPress: () => void;
}) {
	return <Button disabled={disabled} label={label} onPress={onPress} />;
}
