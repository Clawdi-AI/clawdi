import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useI18n } from "../../i18n";
import { Button } from "../button";
import { Icon } from "../icon";
export function SettingsBackButton() {
	const router = useRouter();
	const t = useI18n();
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			accessibilityLabel={t("navigation.back")}
			onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/account"))}
		>
			<Icon as={ArrowLeft} />
		</Button>
	);
}
