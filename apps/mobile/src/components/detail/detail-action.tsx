import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

export function DetailAction({
	label,
	onPress,
	disabled,
	variant = "outline",
}: {
	label: string;
	onPress: () => void;
	disabled?: boolean;
	variant?: ComponentProps<typeof Button>["variant"];
}) {
	return (
		<Button variant={variant} disabled={disabled} onPress={onPress}>
			<Text>{label}</Text>
		</Button>
	);
}
