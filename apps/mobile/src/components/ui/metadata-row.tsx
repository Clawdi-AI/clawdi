import { limitedText } from "@/lib/route-params";
import { AppText, AppView } from "@/components/ui/primitives";

export function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<AppView className="gap-1 rounded-2xl bg-card px-4 py-3">
			<AppText className="text-sm text-muted-foreground">{label}</AppText>
			<AppText selectable className="text-base text-foreground">
				{limitedText(value, 1000)}
			</AppText>
		</AppView>
	);
}
