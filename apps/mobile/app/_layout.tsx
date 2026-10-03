import "../global.css";
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { type ErrorBoundaryProps, Stack } from "expo-router";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadMobileRuntimeConfig, RuntimeConfigProvider } from "../src/config/runtime";
import { I18nProvider } from "../src/i18n";
import { AppearanceProvider } from "../src/providers/appearance-provider";
import { MobileProviders } from "../src/providers/mobile-providers";
import { ConfigurationErrorScreen, ErrorState } from "../src/ui/feedback";
import { AppView } from "../src/ui/primitives";

export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
	return (
		<I18nProvider>
			<AppView className="flex-1 justify-center bg-background p-6">
				<ErrorState onRetry={() => void retry().catch(() => undefined)} />
			</AppView>
		</I18nProvider>
	);
}

function Navigation() {
	return (
		<Stack screenOptions={{ headerShown: false }}>
			<Stack.Screen name="index" />
			<Stack.Screen name="(auth)" />
			<Stack.Screen name="(tabs)" />
		</Stack>
	);
}

export default function RootLayout() {
	const runtime = loadMobileRuntimeConfig();
	return (
		<RuntimeConfigProvider value={runtime}>
			<I18nProvider>
				<GestureHandlerRootView style={{ flex: 1 }}>
					<SafeAreaProvider>
						<AppearanceProvider>
							<HeroUINativeProvider>
								{runtime.ok ? (
									<ClerkProvider
										publishableKey={runtime.value.clerkPublishableKey}
										tokenCache={tokenCache}
									>
										<MobileProviders config={runtime.value}>
											<Navigation />
										</MobileProviders>
									</ClerkProvider>
								) : (
									<ConfigurationErrorScreen reason={runtime.reason} />
								)}
							</HeroUINativeProvider>
						</AppearanceProvider>
					</SafeAreaProvider>
				</GestureHandlerRootView>
			</I18nProvider>
		</RuntimeConfigProvider>
	);
}
