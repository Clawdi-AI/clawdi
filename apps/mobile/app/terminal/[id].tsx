import { Stack } from "expo-router";
import TerminalPage from "@/pages/terminal-page";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
export default function TerminalRoute() {
	const options = useNativeStackOptions();
	return (
		<>
			<Stack.Screen options={{ ...options, headerShown: true, title: "Terminal" }} />
			<TerminalPage />
		</>
	);
}
