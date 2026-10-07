import { Stack } from "expo-router";
import { useI18n } from "@/lib/i18n";
import TerminalPage from "@/pages/terminal-page";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
export default function TerminalRoute() {
	const t = useI18n();
	const options = useNativeStackOptions();
	return (
		<>
			<Stack.Screen options={{ ...options, headerShown: true, title: t("terminal.title") }} />
			<TerminalPage />
		</>
	);
}
