import { useI18n } from "../i18n";
import { ErrorState } from "../ui/feedback";
import { AppText } from "../ui/primitives";
export function ResourceError({ missing, onRetry }: { missing: boolean; onRetry?: () => void }) {
	const t = useI18n();
	return missing ? (
		<AppText className="text-base text-muted">{t("inventory.notFound")}</AppText>
	) : (
		<ErrorState onRetry={onRetry} />
	);
}
