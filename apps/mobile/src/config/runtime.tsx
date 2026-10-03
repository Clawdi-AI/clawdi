import Constants from "expo-constants";
import { createContext, createElement, useContext } from "react";

import { type MobileRuntimeConfigResult, parseMobileRuntimeConfig } from "./runtime-config";

export type { MobileRuntimeConfig, MobileRuntimeConfigResult } from "./runtime-config";

function configuredValue(name: string): unknown {
	const extra = Constants.expoConfig?.extra;
	if (typeof extra !== "object" || extra === null) return undefined;
	const clawdi = extra.clawdi;
	if (typeof clawdi !== "object" || clawdi === null) return undefined;
	return clawdi[name as keyof typeof clawdi];
}

export function loadMobileRuntimeConfig(): MobileRuntimeConfigResult {
	return parseMobileRuntimeConfig({
		cloudApiUrl: configuredValue("cloudApiUrl"),
		clerkPublishableKey: configuredValue("clerkPublishableKey"),
		computeApiUrl: configuredValue("computeApiUrl"),
		clerkOauthProviders: configuredValue("clerkOauthProviders"),
		linkHosts: configuredValue("linkHosts"),
	});
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
