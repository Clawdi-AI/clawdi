import { Button, Host } from "@expo/ui";

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
		<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
			<Button disabled={disabled} label={label} onPress={onPress} />
		</Host>
	);
}
