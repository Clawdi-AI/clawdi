import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useI18n } from "@/lib/i18n";
export function SettingsBackButton() {
	const router = useRouter();
	const t = useI18n();
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
