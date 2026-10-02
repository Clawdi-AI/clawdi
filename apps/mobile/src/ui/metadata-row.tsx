import { limitedText } from "../features/read-helpers";
import { AppText, AppView } from "./primitives";

export function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<AppView className="gap-1 rounded-2xl bg-surface px-4 py-3">
			<AppText className="text-sm text-muted">{label}</AppText>
			<AppText selectable className="text-base text-foreground">
				{limitedText(value, 1000)}
			</AppText>
		</AppView>
	);
}
