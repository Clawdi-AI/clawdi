import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { webLinkPaths } from "@clawdi/shared/linking";
import { z } from "zod";
import { GET as apple } from "./[.]well-known/apple-app-site-association";
import { GET as android } from "./[.]well-known/assetlinks[.]json";

const appleTeamId = "ABCDE12345";
const playFingerprint = Array(32).fill("AB").join(":");
const uploadFingerprint = Array(32).fill("CD").join(":");
const envKeys = ["CLAWDI_APPLE_TEAM_ID", "CLAWDI_ANDROID_CERT_SHA256"] as const;
const originalEnv = envKeys.map((key) => process.env[key]);

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
		const { components } = z
			.object({ components: z.array(z.object({ "/": z.string() })) })
			.parse(data.applinks.details[0]);
		expect(components).toHaveLength(webLinkPaths.length);
		expect(components).toContainEqual({ "/": "/" });
		expect(components).toContainEqual({ "/": "/vault-request" });
		expect(components).toContainEqual({ "/": "/s*" });
		expect(components).toContainEqual({ "/": "/share*" });
		const matches = (candidate: string) =>
			components.some(({ "/": pattern }) =>
				pattern.endsWith("*") ? candidate.startsWith(pattern.slice(0, -1)) : candidate === pattern,
			);
		for (const path of webLinkPaths) {
			if (path.path !== undefined) expect(matches(path.path)).toBe(true);
			else {
				expect(matches(path.pathPrefix)).toBe(true);
				expect(matches(`${path.pathPrefix}/example`)).toBe(true);
			}
		}
		expect(matches("/unrelated-page")).toBe(false);
	});

	test("assetlinks grants URL handling to the app with all configured certificates", async () => {
		process.env.CLAWDI_ANDROID_CERT_SHA256 = ` ${playFingerprint.toLowerCase()}, ${uploadFingerprint},${playFingerprint} `;
		expect(await android().json()).toEqual([
			{
				relation: ["delegate_permission/common.handle_all_urls"],
				target: {
					namespace: "android_app",
					package_name: "ai.clawdi.app",
					sha256_cert_fingerprints: [playFingerprint, uploadFingerprint],
				},
			},
		]);
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
