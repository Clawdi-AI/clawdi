import { expect, test } from "bun:test";
import type { ExpoConfig } from "expo/config";
import { parseMobileRuntimeConfig } from "@/lib/config/runtime-config";
import { readLinkHosts } from "../../../config/linking.cjs";

const configure: (value: { config: ExpoConfig }) => ExpoConfig = require("../../../app.config.js");
test("native associations and runtime routing share the same explicit hostname configuration", () => {
	const previous = process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS;
	const previousIos = process.env.CLAWDI_IOS_BUNDLE_IDENTIFIER;
	const previousAndroid = process.env.CLAWDI_ANDROID_PACKAGE;
	const config: ExpoConfig = {
		name: "Test",
		slug: "test",
		ios: { associatedDomains: ["webcredentials:existing.example.test"] },
	};
	try {
		delete process.env.CLAWDI_IOS_BUNDLE_IDENTIFIER;
		delete process.env.CLAWDI_ANDROID_PACKAGE;
		delete process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS;
		expect(configure({ config }).ios).toEqual(config.ios);
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
			data: [
				{ scheme: "https", host: "links.example.test", pathPrefix: "/s/" },
				{ scheme: "https", host: "links.example.test", path: "/vault-request" },
			],
		});
		const parsed = parseMobileRuntimeConfig({
			cloudApiUrl: "https://api.example.test",
			clerkPublishableKey: "pk_test_example",
			linkHosts: output.extra?.clawdi.linkHosts,
		});
		if (!parsed.ok) throw new Error("Invalid fixture config");
		expect(parsed.value.linkHosts).toEqual(["links.example.test", "second.example.test"]);
		expect(output.ios?.bundleIdentifier).toBeUndefined();
		expect(output.android?.package).toBeUndefined();
		process.env.CLAWDI_IOS_BUNDLE_IDENTIFIER = "test.example.clawdi.ios";
		process.env.CLAWDI_ANDROID_PACKAGE = "test.example.clawdi.android";
		const native = configure({ config });
		expect(native.ios?.bundleIdentifier).toBe("test.example.clawdi.ios");
		expect(native.android?.package).toBe("test.example.clawdi.android");
		expect(native.ios?.associatedDomains).toEqual(output.ios?.associatedDomains);
		expect(native.android?.intentFilters).toEqual(output.android?.intentFilters);
		expect(native.extra).toEqual(output.extra);
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
		if (previousIos === undefined) delete process.env.CLAWDI_IOS_BUNDLE_IDENTIFIER;
		else process.env.CLAWDI_IOS_BUNDLE_IDENTIFIER = previousIos;
		if (previousAndroid === undefined) delete process.env.CLAWDI_ANDROID_PACKAGE;
		else process.env.CLAWDI_ANDROID_PACKAGE = previousAndroid;
		if (previous === undefined) delete process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS;
		else process.env.EXPO_PUBLIC_CLAWDI_LINK_HOSTS = previous;
	}
});
