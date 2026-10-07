import { expect, test } from "bun:test";
import { readLinkHosts, webLinkPaths } from "@clawdi/shared/linking";
import { buildPublishableKey } from "@clerk/shared/keys";
import type { ExpoConfig } from "expo/config";
import { parseMobileRuntimeConfig } from "@/lib/config/runtime-config";

const configure: (value: { config: ExpoConfig }) => ExpoConfig = require("../../../app.config.js");
test("native associations and runtime routing share the same explicit hostname configuration", () => {
	const previous = process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS;
	const config: ExpoConfig = {
		name: "Test",
		slug: "test",
		ios: { associatedDomains: ["webcredentials:existing.example.test"] },
	};
	try {
		delete process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS;
		expect(configure({ config }).ios?.associatedDomains).toEqual(config.ios?.associatedDomains);
		process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS =
			"Links.Example.Test,second.example.test,links.example.test";
		const output = configure({ config });
		expect(output.ios?.associatedDomains).toEqual([
			"webcredentials:existing.example.test",
			"applinks:links.example.test",
			"applinks:second.example.test",
		]);
		expect(output.android?.intentFilters).toHaveLength(2);
		expect(output.android?.intentFilters?.[0]).toEqual({
			action: "VIEW",
			autoVerify: true,
			category: ["BROWSABLE", "DEFAULT"],
			data: webLinkPaths.map((path) => ({ scheme: "https", host: "links.example.test", ...path })),
		});
		const androidData = output.android?.intentFilters?.[0]?.data;
		if (!Array.isArray(androidData)) throw new Error("Missing Android link filters");
		const androidMatches = (path: string) =>
			androidData.some((filter) =>
				filter.path !== undefined
					? filter.path === path
					: filter.pathPrefix !== undefined && path.startsWith(filter.pathPrefix),
			);
		for (const path of [
			"/s",
			"/s/example",
			"/sign-in",
			"/vaults",
			"/vaults/example",
			"/vault-request",
			"/skills",
			"/skills/owner/repository/skill",
		]) {
			expect(androidMatches(path)).toBe(true);
		}
		for (const path of [
			"/skill.md",
			"/skills.md",
			"/silly",
			"/sign-in-extra",
			"/vault-request-extra",
			"/vaults-extra",
			"/shareholder",
			"/get-started.md",
			"/llms.txt",
			"/.well-known/agent-skills/index.json",
		]) {
			expect(androidMatches(path)).toBe(false);
		}
		// Legacy Android cannot negate a static pathPrefix; native intake opens these in Custom Tabs.
		expect(androidMatches("/skills/clawdi/SKILL.md")).toBe(true);
		const parsed = parseMobileRuntimeConfig(
			{
				cloudApiUrl: "https://api.example.test",
				clerkPublishableKey: "pk_test_example",
				linkHosts: output.extra?.clawdi.linkHosts,
			},
			{ isDevelopment: true },
		);
		if (!parsed.ok) throw new Error("Invalid fixture config");
		expect(parsed.value.linkHosts).toEqual(["links.example.test", "second.example.test"]);
		expect(output.ios?.bundleIdentifier).toBe("ai.clawdi.app");
		expect(output.android?.package).toBe("ai.clawdi.app");
		for (const invalid of [
			"*.example.test",
			"https://example.test",
			"user@example.test",
			"example.test:443",
			"example.test/path",
			"example.test,",
			"localhost",
			"127.0.0.1",
		]) {
			process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS = invalid;
			expect(() => configure({ config })).toThrow();
			expect(() => readLinkHosts(invalid)).toThrow();
		}
	} finally {
		if (previous === undefined) delete process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS;
		else process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS = previous;
	}
});

test("Clerk native passkeys associate the Frontend API encoded in the publishable key", () => {
	const previous = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
	const config: ExpoConfig = { name: "Test", slug: "test" };
	try {
		delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
		expect(configure({ config }).ios?.associatedDomains).toBeUndefined();
		process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = buildPublishableKey("clerk.example.test");
		expect(configure({ config }).ios?.associatedDomains).toEqual([
			"webcredentials:clerk.example.test",
		]);
	} finally {
		if (previous === undefined) delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
		else process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = previous;
	}
});

test("release metadata stays usable without owner credentials and enables updates when configured", () => {
	const previous = process.env.EAS_PROJECT_ID;
	const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
	const previousCustomerCenter = process.env.EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED;
	const config: ExpoConfig = {
		name: "Test",
		slug: "test",
	};
	try {
		delete process.env.EAS_PROJECT_ID;
		delete process.env.EXPO_PUBLIC_SENTRY_DSN;
		delete process.env.EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED;
		const local = configure({ config });
		expect(local.runtimeVersion).toEqual({ policy: "fingerprint" });
		expect(local.ios?.config?.usesNonExemptEncryption).toBe(false);
		expect(local.ios?.supportsTablet).toBe(false);
		expect(local.android?.allowBackup).toBe(false);
		expect(local.updates?.url).toBeUndefined();
		expect(local.extra?.eas?.projectId).toBeUndefined();
		expect(local.plugins).toContain("@sentry/react-native/expo");
		expect(local.ios?.privacyManifests?.NSPrivacyCollectedDataTypes).toContainEqual({
			NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypePurchaseHistory",
			NSPrivacyCollectedDataTypeLinked: true,
			NSPrivacyCollectedDataTypeTracking: false,
			NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
		});
		expect(local.extra?.clawdi?.revenueCatCustomerCenterEnabled).toBe(false);
		process.env.EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED = "1";
		expect(configure({ config }).extra?.clawdi?.revenueCatCustomerCenterEnabled).toBe(true);
		process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
		process.env.EAS_PROJECT_ID = "00000000-0000-4000-8000-000000000000";
		const linked = configure({ config });
		expect(linked.extra?.eas?.projectId).toBe(process.env.EAS_PROJECT_ID);
		expect(linked.updates?.url).toBe(`https://u.expo.dev/${process.env.EAS_PROJECT_ID}`);
		expect(linked.plugins).toEqual(local.plugins);
		expect(linked.extra?.clawdi?.sentryDsn).toBe(process.env.EXPO_PUBLIC_SENTRY_DSN);
	} finally {
		if (previous === undefined) delete process.env.EAS_PROJECT_ID;
		else process.env.EAS_PROJECT_ID = previous;
		if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
		else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
		if (previousCustomerCenter === undefined)
			delete process.env.EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED;
		else process.env.EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED = previousCustomerCenter;
	}
});
