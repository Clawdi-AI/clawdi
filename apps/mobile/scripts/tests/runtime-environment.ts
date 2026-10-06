import { expect, mock } from "bun:test";

// Run in a child process so native module mocks cannot leak into other suites.
Object.defineProperty(globalThis, "__DEV__", { value: false });
const clawdi = {
	cloudApiUrl: "https://cloud.example.test",
	computeApiUrl: "https://compute.example.test",
	clerkPublishableKey: "pk_test_example",
	sentryDsn: process.env.TEST_SENTRY_DSN,
};
mock.module("expo-constants", () => ({ default: { expoConfig: { extra: { clawdi } } } }));
mock.module("expo-updates", () => ({ channel: "" }));
mock.module("@/platform/auth/auth-client", () => ({ isDevAuthBypass: () => false }));
const init = mock((options: { environment?: string; release?: string; dist?: string }) => options);
const captureException = mock();
const wrap = mock((component: unknown) => component);
mock.module("@sentry/react-native", () => ({ init, captureException, wrap }));

const { loadMobileRuntimeConfig } = await import("../../src/lib/config/runtime");
expect(loadMobileRuntimeConfig()).toEqual({ ok: false, reason: "invalid" });
clawdi.clerkPublishableKey = "pk_live_example";
expect(loadMobileRuntimeConfig().ok).toBe(true);

const { reportRootError, wrapRootLayout } = await import("../../src/platform/observability");
const root = () => null;
reportRootError(new Error("Test root error"), "/settings");
expect(wrapRootLayout(root)).toBe(root);
if (clawdi.sentryDsn) {
	expect(init).toHaveBeenCalledTimes(1);
	expect(init.mock.calls[0]?.[0].environment).toBe("production");
	expect(init.mock.calls[0]?.[0]).not.toHaveProperty("release");
	expect(init.mock.calls[0]?.[0]).not.toHaveProperty("dist");
	expect(captureException).toHaveBeenCalledTimes(1);
	expect(wrap).toHaveBeenCalledTimes(1);
} else {
	expect(init).not.toHaveBeenCalled();
	expect(captureException).not.toHaveBeenCalled();
	expect(wrap).not.toHaveBeenCalled();
}
