import "../../../global.css";
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import {
	type ErrorBoundaryProps,
	Stack,
	useNavigationContainerRef,
	usePathname,
} from "expo-router";
import { useEffect, useRef } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConfigurationErrorScreen, ErrorState } from "@/components/ui/feedback";
import { AppView } from "@/components/ui/view";
import { useAccountSuspended } from "@/lib/api-provider";
import { loadMobileRuntimeConfig, RuntimeConfigProvider } from "@/lib/config/runtime";
import { I18nProvider } from "@/lib/i18n";
import { AppearanceProvider } from "@/platform/appearance-provider";
import { isDevAuthBypass } from "@/platform/auth/auth-client";
import { MobileProviders } from "@/platform/mobile-providers";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
import { formSheetOptions } from "@/platform/navigation/sheet-options";
import {
	navigationIntegration,
	reportRootError,
	setObservabilityPathname,
	wrapRootLayout,
} from "@/platform/observability";
import { AppSplash, HideSplash } from "@/platform/splash";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
	const pathname = usePathname();
	const pathnameRef = useRef(pathname);
	pathnameRef.current = pathname;
	useEffect(() => reportRootError(error, pathnameRef.current), [error]);
	return (
		<I18nProvider>
			<HideSplash ready />
			<AppView className="flex-1 justify-center bg-background p-6">
				<ErrorState onRetry={() => void retry().catch(() => undefined)} />
			</AppView>
		</I18nProvider>
	);
}

function Navigation() {
	const options = useNativeStackOptions();
	const suspended = useAccountSuspended();
	// Web's AccountSuspensionBoundary: a suspended account sees one full-screen state instead of
	// any account route. Expo Router's protected routes redirect to the first available screen.
	return (
		<Stack screenOptions={{ headerShown: false }}>
			<Stack.Protected guard={suspended}>
				<Stack.Screen name="account-suspended" options={{ gestureEnabled: false }} />
			</Stack.Protected>
			<Stack.Protected guard={!suspended}>
				<Stack.Screen name="(tabs)" />
				<Stack.Screen name="(sheets)" options={formSheetOptions} />
				<Stack.Screen name="vault-request" options={{ ...options, headerShown: true }} />
				<Stack.Screen name="terminal/[id]" />
			</Stack.Protected>
			<Stack.Screen name="s/[id]" options={{ ...options, headerShown: true }} />
			<Stack.Screen name="share/[token]" options={{ ...options, headerShown: true }} />
			<Stack.Screen name="(auth)" />
		</Stack>
	);
}

function RootLayout() {
	const navigationRef = useNavigationContainerRef();
	useEffect(() => {
		navigationIntegration?.registerNavigationContainer(navigationRef);
	}, [navigationRef]);
	const pathname = usePathname();
	// Update before child effects can report errors or breadcrumbs for a sensitive route.
	setObservabilityPathname(pathname);
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
							<AppSplash />
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

export default wrapRootLayout(RootLayout);

export const unstable_settings = { initialRouteName: "(tabs)" };
