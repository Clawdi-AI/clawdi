import { useRouter } from "expo-router";
import { Text as AppText } from "@/components/ui/text";
import { AppPressable } from "@/components/ui/view";
import { useI18n } from "@/lib/i18n";

export function BackButton() {
	const router = useRouter();
	const t = useI18n();
	return (
		<AppPressable
			accessibilityRole="button"
			className="self-start py-2"
			onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
		>
			<AppText className="text-base font-semibold text-primary">‹ {t("navigation.back")}</AppText>
		</AppPressable>
	);
}
