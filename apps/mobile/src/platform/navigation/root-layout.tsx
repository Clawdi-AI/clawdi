import "../../../global.css";
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { type ErrorBoundaryProps, Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppearanceProvider } from "@/components/appearance-provider";
import { MobileProviders } from "@/components/mobile-providers";
import { ConfigurationErrorScreen, ErrorState } from "@/components/ui/feedback";
import { AppView } from "@/components/ui/primitives";
import { loadMobileRuntimeConfig, RuntimeConfigProvider } from "@/lib/config/runtime";
import { I18nProvider } from "@/lib/i18n";
import { isDevAuthBypass } from "@/platform/auth/auth-client";
import { useAppFonts } from "@/platform/fonts";

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
			<Stack.Screen name="(auth)" />
			<Stack.Screen name="(tabs)" />
		</Stack>
	);
}

export default function RootLayout() {
	const fontsReady = useAppFonts();
	if (!fontsReady) return null;
	const runtime = loadMobileRuntimeConfig();
	const app = runtime.ok ? (
		<MobileProviders config={runtime.value}>
			<Navigation />
		</MobileProviders>
	) : null;
	return (
		<RuntimeConfigProvider value={runtime}>
			<I18nProvider>
				<GestureHandlerRootView style={{ flex: 1 }}>
					<SafeAreaProvider>
						<AppearanceProvider>
							{runtime.ok ? (
								isDevAuthBypass() ? (
									app
								) : (
									<ClerkProvider
										publishableKey={runtime.value.clerkPublishableKey}
										tokenCache={tokenCache}
										experimental={{ rethrowOfflineNetworkErrors: true }}
									>
										{app}
									</ClerkProvider>
								)
							) : (
								<ConfigurationErrorScreen reason={runtime.reason} />
							)}
						</AppearanceProvider>
					</SafeAreaProvider>
				</GestureHandlerRootView>
			</I18nProvider>
		</RuntimeConfigProvider>
	);
}

export const unstable_settings = { initialRouteName: "(tabs)" };
