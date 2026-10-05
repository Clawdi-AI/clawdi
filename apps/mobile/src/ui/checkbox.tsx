import { CHECKBOX_ICON_CLASS, checkboxClasses } from "@clawdi/shared/ui";
import { Check } from "lucide-react-native";
import { Icon } from "./icon";
import { AppPressable } from "./view";
import { resolveWebClasses } from "./web-classes";
import { webBoth } from "./web-layout";

export function Checkbox({
	checked,
	disabled,
	onCheckedChange,
	accessibilityLabel,
}: {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
	accessibilityLabel?: string;
}) {
	const classes = resolveWebClasses(checkboxClasses.root, {
		"data-checked": checked,
		disabled: Boolean(disabled),
	});
	return (
		<AppPressable
			accessibilityRole="checkbox"
			accessibilityLabel={accessibilityLabel}
			accessibilityState={{ checked, disabled }}
			disabled={disabled}
			onPress={() => onCheckedChange(!checked)}
			className={classes.view}
		>
			{checked ? (
				<Icon as={Check} className={`${classes.text} ${webBoth(CHECKBOX_ICON_CLASS)}`} />
			) : null}
		</AppPressable>
	);
}
