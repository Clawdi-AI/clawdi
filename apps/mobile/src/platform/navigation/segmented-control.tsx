import { SegmentedControl } from "@expo/ui/community/segmented-control";
import { useCSSVariable, useUniwind } from "uniwind";

export type NativeSegmentsProps = {
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	disabled?: boolean;
};

/** Native single-choice control; options retain the Web labels and ordering. */
export function NativeSegments({
	value,
	options,
	onChange,
	disabled = false,
}: NativeSegmentsProps) {
	const { theme } = useUniwind();
	const tint = useCSSVariable("--color-accent");
	return (
		<SegmentedControl
			values={options.map((option) => option.label)}
			selectedIndex={options.findIndex((option) => option.value === value)}
			enabled={!disabled}
			appearance={theme === "dark" ? "dark" : "light"}
			tintColor={typeof tint === "string" ? tint : undefined}
			onChange={({ nativeEvent }) => {
				const option = options[nativeEvent.selectedSegmentIndex];
				if (option) onChange(option.value);
			}}
		/>
	);
}
