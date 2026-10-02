import "../global.css";
import "../contracts";
import { Stack } from "expo-router";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function ProbeLayout() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<SafeAreaProvider>
				<HeroUINativeProvider>
					<Stack />
				</HeroUINativeProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
