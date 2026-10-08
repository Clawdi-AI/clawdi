import { Text } from "@/components/ui/text";
import { useI18n } from "@/lib/i18n";
import type { StoreNotice } from "./store-presentation";

export function StoreNoticeText({ notice }: { notice: StoreNotice }) {
	const t = useI18n();
	return (
		<Text
			accessibilityRole={notice.tone === "warning" ? "alert" : undefined}
			className={
				notice.tone === "success" ? "text-success-muted-foreground" : "text-muted-foreground"
			}
		>
			{t(notice.key, notice.values)}
		</Text>
	);
}
