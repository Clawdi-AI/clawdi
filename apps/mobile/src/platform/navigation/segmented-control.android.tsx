import {
	Host,
	SegmentedButton,
	SingleChoiceSegmentedButtonRow,
	Text,
} from "@expo/ui/jetpack-compose";
import { useCSSVariable, useUniwind } from "uniwind";
import type { NativeSegmentsProps } from "@/platform/navigation/segmented-control";

/** The community adapter exposes only tint; Compose also supports Web tokens and Geist. */
export function NativeSegments({
	value,
	options,
	onChange,
	disabled = false,
}: NativeSegmentsProps) {
	const { theme } = useUniwind();
	const [foreground, accent, background, border] = useCSSVariable([
		"--color-foreground",
		"--color-accent",
		"--color-background",
		"--color-border",
	]);
	const color = (v: string | number | undefined) => (typeof v === "string" ? v : undefined);
	return (
		<Host matchContents={{ vertical: true }} colorScheme={theme === "dark" ? "dark" : "light"}>
			<SingleChoiceSegmentedButtonRow>
				{options.map((option) => (
					<SegmentedButton
						key={option.value}
						selected={option.value === value}
						enabled={!disabled}
						onClick={() => onChange(option.value)}
						colors={{
							activeContainerColor: color(accent),
							inactiveContainerColor: color(background),
							activeContentColor: color(foreground),
							inactiveContentColor: color(foreground),
							activeBorderColor: color(border),
							inactiveBorderColor: color(border),
						}}
					>
						<SegmentedButton.Label>
							<Text style={{ fontFamily: "Geist-Medium", fontSize: 14 }}>{option.label}</Text>
						</SegmentedButton.Label>
					</SegmentedButton>
				))}
			</SingleChoiceSegmentedButtonRow>
		</Host>
	);
}
