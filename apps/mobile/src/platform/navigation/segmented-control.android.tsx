import {
	Host,
	SegmentedButton,
	SingleChoiceSegmentedButtonRow,
	Text,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth, weight } from "@expo/ui/jetpack-compose/modifiers";
import { useCSSVariable, useUniwind } from "uniwind";
import { AppView } from "@/components/ui/view";
import type { NativeSegmentsProps } from "@/platform/navigation/segmented-control";

/** The community adapter exposes only tint; Compose also supports Web tokens and Geist. */
export function NativeSegments({
	value,
	options,
	onChange,
	disabled = false,
	compact = false,
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
		// Keep a native parent so list subview clipping never attaches the Host mid-layout (0×0 Host).
		<AppView collapsable={false}>
			<Host matchContents={{ vertical: true }} colorScheme={theme === "dark" ? "dark" : "light"}>
				<SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
					{options.map((option) => (
						<SegmentedButton
							key={option.value}
							selected={option.value === value}
							enabled={!disabled}
							modifiers={[weight(1)]}
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
								<Text
									maxLines={compact ? 1 : 2}
									overflow="ellipsis"
									style={{
										fontFamily: compact ? "Geist-Regular" : "Geist-Medium",
										fontSize: compact ? 12 : 14,
									}}
								>
									{option.label}
								</Text>
							</SegmentedButton.Label>
						</SegmentedButton>
					))}
				</SingleChoiceSegmentedButtonRow>
			</Host>
		</AppView>
	);
}
