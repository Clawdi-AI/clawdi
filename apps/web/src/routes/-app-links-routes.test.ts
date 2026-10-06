import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { webLinkExclusions, webLinkPaths } from "@clawdi/shared/linking";
import { z } from "zod";
import { AGENT_FILES } from "@/lib/agent-files";
import { GET as apple } from "./[.]well-known/apple-app-site-association";
import { GET as android } from "./[.]well-known/assetlinks[.]json";

const appleTeamId = "ABCDE12345";
const playFingerprint = Array(32).fill("AB").join(":");
const uploadFingerprint = Array(32).fill("CD").join(":");
const envKeys = ["CLAWDI_APPLE_TEAM_ID", "CLAWDI_ANDROID_CERT_SHA256"] as const;
const originalEnv = envKeys.map((key) => process.env[key]);
const componentsSchema = z.array(z.object({ "/": z.string(), exclude: z.boolean().optional() }));

// Apple and Android dynamic rules use ordered, first-match glob components.
function matchesLink(components: z.infer<typeof componentsSchema>, candidate: string) {
	const match = components.find(({ "/": pattern }) => {
		const glob = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${glob}$`).test(candidate);
	});
	return Boolean(match && !match.exclude);
}

function assertLinkBoundaries(components: z.infer<typeof componentsSchema>) {
	for (const path of [
		"/",
		"/s",
		"/s/example",
		"/share/example",
		"/sign-in",
		"/vaults",
		"/vaults/example",
		"/vault-request",
		"/skills",
		"/skills/owner/repository/skill",
	]) {
		expect(matchesLink(components, path)).toBe(true);
	}
	for (const path of [
		...Object.values(AGENT_FILES).map((file) => file.path),
		"/skills/another/SKILL.md",
		"/skills/owner/repository/SKILL.md",
		"/skills.md",
		"/silly",
		"/sign-in-extra",
		"/vault-request-extra",
		"/vaults-extra",
		"/shareholder",
		"/unrelated-page",
	]) {
		expect(matchesLink(components, path)).toBe(false);
	}
}

beforeEach(() => {
	for (const key of envKeys) delete process.env[key];
});

afterEach(() => {
	for (const [index, key] of envKeys.entries()) {
		const value = originalEnv[index];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("mobile association routes", () => {
	for (const [platform, GET, key, value] of [
		["Apple", apple, "CLAWDI_APPLE_TEAM_ID", appleTeamId],
		["Android", android, "CLAWDI_ANDROID_CERT_SHA256", playFingerprint],
	] as const) {
		test(`${platform} serves JSON without redirecting`, () => {
			process.env[key] = value;
			const response = GET();
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("cache-control")).toBe(
				"public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
			);
		});

		for (const unset of [undefined, "", "  "]) {
			test(`${platform} returns 404 for missing or blank signing identity (${String(unset)})`, async () => {
				if (unset !== undefined) process.env[key] = unset;
				const response = GET();
				expect(response.status).toBe(404);
				expect(response.headers.get("location")).toBeNull();
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(await response.text()).toBe("");
			});
		}
	}

	test("AASA uses the same app identifier for links and web credentials", async () => {
		process.env.CLAWDI_APPLE_TEAM_ID = ` ${appleTeamId} `;
		const data = await apple().json();
		expect(data).toMatchObject({
			applinks: { details: [{ appIDs: [`${appleTeamId}.ai.clawdi.app`] }] },
			webcredentials: { apps: [`${appleTeamId}.ai.clawdi.app`] },
		});
		const components = componentsSchema.parse(data.applinks.details[0].components);
		expect(components.slice(0, webLinkExclusions.length)).toEqual(
			webLinkExclusions.map((path) => ({ "/": path, exclude: true })),
		);
		expect(components).toHaveLength(webLinkPaths.length + webLinkExclusions.length);
		expect(components).toContainEqual({ "/": "/" });
		expect(components).toContainEqual({ "/": "/vault-request" });
		expect(components).toContainEqual({ "/": "/s" });
		expect(components).toContainEqual({ "/": "/s/*" });
		expect(components).toContainEqual({ "/": "/share" });
		expect(components).toContainEqual({ "/": "/share/*" });
		for (const path of webLinkPaths) {
			if (path.path !== undefined) expect(matchesLink(components, path.path)).toBe(true);
			else {
				expect(matchesLink(components, path.pathPrefix)).toBe(true);
				expect(matchesLink(components, `${path.pathPrefix}example`)).toBe(true);
			}
		}
		assertLinkBoundaries(components);
	});

	test("assetlinks grants URL handling to the app with all configured certificates", async () => {
		process.env.CLAWDI_ANDROID_CERT_SHA256 = ` ${playFingerprint.toLowerCase()}, ${uploadFingerprint},${playFingerprint} `;
		process.env.CLAWDI_APPLE_TEAM_ID = appleTeamId;
		const appleData = await apple().json();
		const linkComponents = componentsSchema.parse(appleData.applinks.details[0].components);
		const data = await android().json();
		expect(data).toEqual([
			{
				relation: ["delegate_permission/common.handle_all_urls"],
				target: {
					namespace: "android_app",
					package_name: "ai.clawdi.app",
					sha256_cert_fingerprints: [playFingerprint, uploadFingerprint],
				},
				relation_extensions: {
					"delegate_permission/common.handle_all_urls": {
						dynamic_app_link_components: [...linkComponents, { "/": "*", exclude: true }],
					},
				},
			},
		]);
		const dynamic = componentsSchema.parse(
			data[0].relation_extensions["delegate_permission/common.handle_all_urls"]
				.dynamic_app_link_components,
		);
		assertLinkBoundaries(dynamic);
	});

	test("invalid signing identities fail closed without affecting the other platform", () => {
		process.env.CLAWDI_APPLE_TEAM_ID = "not-a-team-id";
		process.env.CLAWDI_ANDROID_CERT_SHA256 = playFingerprint;
		expect(apple().status).toBe(404);
		expect(android().status).toBe(200);
		process.env.CLAWDI_APPLE_TEAM_ID = appleTeamId;
		for (const invalid of ["placeholder", `${playFingerprint},`, `${playFingerprint},invalid`]) {
			process.env.CLAWDI_ANDROID_CERT_SHA256 = invalid;
			expect(android().status).toBe(404);
			expect(apple().status).toBe(200);
		}
	});
});
