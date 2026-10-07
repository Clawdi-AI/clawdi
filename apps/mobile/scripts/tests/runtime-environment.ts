import { expect, mock } from "bun:test";
import type { ReactNativeOptions } from "@sentry/react-native";

// Run in a child process so native module mocks cannot leak into other suites.
const isDevelopment = process.env.TEST_IS_DEVELOPMENT === "1";
Object.defineProperty(globalThis, "__DEV__", { value: isDevelopment });
const clawdi = {
	cloudApiUrl: "https://cloud.example.test",
	computeApiUrl: "https://compute.example.test",
	clerkPublishableKey: "pk_test_example",
	sentryDsn: process.env.TEST_SENTRY_DSN,
};
mock.module("expo-constants", () => ({ default: { expoConfig: { extra: { clawdi } } } }));
mock.module("expo-updates", () => ({ channel: "" }));
mock.module("expo", () => ({ isRunningInExpoGo: () => false }));
mock.module("@/platform/auth/auth-client", () => ({ isDevAuthBypass: () => false }));
const init = mock((options: ReactNativeOptions) => options);
const captureException = mock();
const wrap = mock((component: unknown) => component);
const integration = { name: "ReactNavigation", registerNavigationContainer: mock() };
const reactNavigationIntegration = mock(() => integration);
mock.module("@sentry/react-native", () => ({
	init,
	captureException,
	wrap,
	reactNavigationIntegration,
}));

const { loadMobileRuntimeConfig } = await import("../../src/lib/config/runtime");
if (isDevelopment) expect(loadMobileRuntimeConfig().ok).toBe(true);
else expect(loadMobileRuntimeConfig()).toEqual({ ok: false, reason: "invalid" });
clawdi.clerkPublishableKey = "pk_live_example";
expect(loadMobileRuntimeConfig().ok).toBe(true);

const { reportRootError, wrapRootLayout } = await import("../../src/platform/observability");
const root = () => null;
reportRootError(new Error("Test root error"), "/settings");
expect(wrapRootLayout(root)).toBe(root);
if (clawdi.sentryDsn) {
	expect(init).toHaveBeenCalledTimes(1);
	expect(init.mock.calls[0]?.[0].integrations).toEqual([integration]);
	expect(reactNavigationIntegration).toHaveBeenCalledTimes(1);
	const transaction = { type: "transaction", transaction: "vault-request" } as const;
	expect(init.mock.calls[0]?.[0].beforeSendTransaction?.(transaction, {})).toBeNull();
	if (process.env.EXPO_PUBLIC_CLAWDI_ENV) {
		expect(init.mock.calls[0]?.[0].environment).toBe(process.env.EXPO_PUBLIC_CLAWDI_ENV);
	} else {
		expect(init.mock.calls[0]?.[0]).not.toHaveProperty("environment");
	}
	expect(init.mock.calls[0]?.[0]).not.toHaveProperty("release");
	expect(init.mock.calls[0]?.[0]).not.toHaveProperty("dist");
	expect(captureException).toHaveBeenCalledTimes(1);
	expect(wrap).toHaveBeenCalledTimes(1);
} else {
	expect(init).not.toHaveBeenCalled();
	expect(reactNavigationIntegration).not.toHaveBeenCalled();
	expect(captureException).not.toHaveBeenCalled();
	expect(wrap).not.toHaveBeenCalled();
}
