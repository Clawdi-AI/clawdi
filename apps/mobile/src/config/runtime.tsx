import { readApiBaseUrl } from "@clawdi/shared/api";
import Constants from "expo-constants";
import { createContext, useContext } from "react";

export type MobileRuntimeConfig = Readonly<{
	cloudApiUrl: string;
	clerkPublishableKey: string;
}>;

export type MobileRuntimeConfigResult =
	| { ok: true; value: MobileRuntimeConfig }
	| { ok: false; reason: "missing" | "invalid" };

function configuredValue(name: string): unknown {
	const extra = Constants.expoConfig?.extra;
	if (typeof extra !== "object" || extra === null) return undefined;
	const clawdi = extra.clawdi;
	if (typeof clawdi !== "object" || clawdi === null) return undefined;
	return clawdi[name as keyof typeof clawdi];
}

function requiredString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function loadMobileRuntimeConfig(): MobileRuntimeConfigResult {
	const cloudApiUrl = configuredValue("cloudApiUrl");
	const clerkPublishableKey = configuredValue("clerkPublishableKey");
	if (!requiredString(cloudApiUrl) || !requiredString(clerkPublishableKey)) {
		return { ok: false, reason: "missing" };
	}
	if (!clerkPublishableKey.startsWith("pk_")) return { ok: false, reason: "invalid" };
	try {
		return {
			ok: true,
			value: {
				cloudApiUrl: readApiBaseUrl(cloudApiUrl),
				clerkPublishableKey,
			},
		};
	} catch {
		return { ok: false, reason: "invalid" };
	}
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
	return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useMobileRuntimeConfig(): MobileRuntimeConfigResult {
	return useContext(RuntimeConfigContext);
}
