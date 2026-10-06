import { expect, test } from "bun:test";
import type { ExpoConfig } from "expo/config";
import { parseMobileRuntimeConfig } from "@/lib/config/runtime-config";
import { readLinkHosts, webLinkPaths } from "../../../config/linking.cjs";

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

test("release metadata stays usable without owner credentials and enables updates when configured", () => {
	const previous = process.env.EAS_PROJECT_ID;
	const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
	const config: ExpoConfig = {
		name: "Test",
		slug: "test",
		updates: { url: "https://u.expo.dev/stale-project", fallbackToCacheTimeout: 0 },
		extra: { eas: { projectId: "stale-project" } },
	};
	try {
		delete process.env.EAS_PROJECT_ID;
		delete process.env.EXPO_PUBLIC_SENTRY_DSN;
		const local = configure({ config });
		expect(local.runtimeVersion).toEqual({ policy: "fingerprint" });
		expect(local.ios?.config?.usesNonExemptEncryption).toBe(false);
		expect(local.ios?.supportsTablet).toBe(false);
		expect(local.android?.allowBackup).toBe(false);
		expect(local.updates?.url).toBeUndefined();
		expect(local.extra?.eas?.projectId).toBeUndefined();
		expect(local.plugins).not.toContain("@sentry/react-native/expo");
		process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
		process.env.EAS_PROJECT_ID = "00000000-0000-4000-8000-000000000000";
		const linked = configure({ config });
		expect(linked.extra?.eas?.projectId).toBe(process.env.EAS_PROJECT_ID);
		expect(linked.updates?.url).toBe(`https://u.expo.dev/${process.env.EAS_PROJECT_ID}`);
		expect(linked.plugins).toContain("@sentry/react-native/expo");
		expect(linked.extra?.clawdi?.sentryDsn).toBe(process.env.EXPO_PUBLIC_SENTRY_DSN);
	} finally {
		if (previous === undefined) delete process.env.EAS_PROJECT_ID;
		else process.env.EAS_PROJECT_ID = previous;
		if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
		else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
	}
});
