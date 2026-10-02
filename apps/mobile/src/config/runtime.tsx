import { readApiBaseUrl } from "@clawdi/shared/api";
import Constants from "expo-constants";
import { createContext, createElement, useContext } from "react";

export type MobileRuntimeConfig = Readonly<{
	cloudApiUrl: string;
	clerkPublishableKey: string;
}>;

export type MobileRuntimeConfigResult =
	| { ok: true; value: MobileRuntimeConfig }
	| { ok: false; reason: "missing" | "invalid" };

type RuntimeConfigValues = Readonly<{
	cloudApiUrl: unknown;
	clerkPublishableKey: unknown;
}>;

function configuredValue(name: string): unknown {
	const extra = Constants.expoConfig?.extra;
	if (typeof extra !== "object" || extra === null) return undefined;
	const clawdi = extra.clawdi;
	if (typeof clawdi !== "object" || clawdi === null) return undefined;
	return clawdi[name as keyof typeof clawdi];
}

function requiredString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const clerkPublishableKeyPattern = /^pk_(?:test|live)_[A-Za-z0-9_-]+$/;

export function parseMobileRuntimeConfig(values: RuntimeConfigValues): MobileRuntimeConfigResult {
	const cloudApiUrl = requiredString(values.cloudApiUrl);
	const clerkPublishableKey = requiredString(values.clerkPublishableKey);
	if (!cloudApiUrl || !clerkPublishableKey) {
		return { ok: false, reason: "missing" };
	}
	if (!clerkPublishableKeyPattern.test(clerkPublishableKey))
		return { ok: false, reason: "invalid" };
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

export function loadMobileRuntimeConfig(): MobileRuntimeConfigResult {
	return parseMobileRuntimeConfig({
		cloudApiUrl: configuredValue("cloudApiUrl"),
		clerkPublishableKey: configuredValue("clerkPublishableKey"),
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
