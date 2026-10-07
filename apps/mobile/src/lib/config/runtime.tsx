import Constants from "expo-constants";
import { createContext, createElement, useContext } from "react";
import {
	type MobileRuntimeConfigResult,
	parseMobileRuntimeConfig,
} from "@/lib/config/runtime-config";
import { isDevAuthBypass } from "@/platform/auth/auth-client";

export type { MobileRuntimeConfig } from "@/lib/config/runtime-config";

function configuredValue(name: string): unknown {
	const extra = Constants.expoConfig?.extra;
	if (typeof extra !== "object" || extra === null) return undefined;
	const clawdi = extra.clawdi;
	if (typeof clawdi !== "object" || clawdi === null) return undefined;
	return clawdi[name as keyof typeof clawdi];
}

export function loadMobileRuntimeConfig(): MobileRuntimeConfigResult {
	return parseMobileRuntimeConfig(
		{
			cloudApiUrl: configuredValue("cloudApiUrl"),
			clerkPublishableKey: configuredValue("clerkPublishableKey"),
			computeApiUrl: configuredValue("computeApiUrl"),
			revenueCatAppleKey: configuredValue("revenueCatAppleKey"),
			revenueCatGoogleKey: configuredValue("revenueCatGoogleKey"),
			linkHosts: configuredValue("linkHosts"),
		},
		{
			isDevelopment: __DEV__,
			requireClerk: !isDevAuthBypass(),
			environment: process.env.EXPO_PUBLIC_CLAWDI_ENV,
		},
	);
}

const RuntimeConfigContext = createContext<MobileRuntimeConfigResult>({
	ok: false,
	reason: "missing",
});

export function RuntimeConfigProvider({
	children,
	value,
}: {
	children: React.ReactNode;
	value: MobileRuntimeConfigResult;
}) {
	return createElement(RuntimeConfigContext.Provider, { value }, children);
}

export function useMobileRuntimeConfig(): MobileRuntimeConfigResult {
	return useContext(RuntimeConfigContext);
}
