import { Button, Host } from "@expo/ui";
import type { ReactNode } from "react";
import { useUniwind } from "uniwind";

function NativeControlHost({ children }: { children: ReactNode }) {
	const { theme } = useUniwind();
	return (
		<Host
			colorScheme={theme === "dark" ? "dark" : "light"}
			matchContents={{ vertical: true }}
			style={{ width: "100%" }}
		>
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
