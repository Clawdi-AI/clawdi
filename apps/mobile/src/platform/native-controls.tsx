import { Button, Host } from "@expo/ui";
import type { ReactNode } from "react";
import { useUniwind } from "uniwind";
import { AppView } from "@/components/ui/view";

function NativeControlHost({ children }: { children: ReactNode }) {
	const { theme } = useUniwind();
	return (
		// Keep a native parent so list subview clipping never attaches the Host mid-layout (0×0 Host).
		<AppView className="w-full" collapsable={false}>
			<Host colorScheme={theme === "dark" ? "dark" : "light"} matchContents={{ vertical: true }}>
				{children}
			</Host>
		</AppView>
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
