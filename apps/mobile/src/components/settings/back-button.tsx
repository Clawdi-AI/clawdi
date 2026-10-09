import { useRouter } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import { useContext } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useI18n } from "@/lib/i18n";
export function SettingsBackButton() {
	const headerHeight = useContext(HeaderHeightContext);
	const router = useRouter();
	const t = useI18n();
	if (headerHeight) return null;
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			accessibilityLabel={t("navigation.back")}
			onPress={() => (router.canGoBack() ? router.back() : router.replace("/settings"))}
		>
			<Icon as={ArrowLeft} />
		</Button>
	);
}
