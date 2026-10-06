import { ErrorState } from "@/components/ui/feedback";
import { AppText } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n";
export function ResourceError({ missing, onRetry }: { missing: boolean; onRetry?: () => void }) {
	const t = useI18n();
	return missing ? (
		<AppText className="text-base text-muted-foreground">{t("inventory.notFound")}</AppText>
	) : (
		<ErrorState onRetry={onRetry} />
	);
}
