import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	CHANNEL_ATTRIBUTION_COOKIE,
	captureChannelAttribution,
	verifyChannelAttribution,
} from "./channel-attribution.server";

const SECRET = "channel-test-signing-key-32-bytes!";
const VECTOR =
	"v1.sui.1000.1900.nnnnnnnnnnnnnnnnnnnnnn.KMM6m4ILVTi40a2cVp9w7zEEW3n-LgE5RI1-KnU8psk";
const originalSecret = process.env.CHANNEL_ATTRIBUTION_SECRET;
let clock: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	clock?.mockRestore();
	if (originalSecret === undefined) delete process.env.CHANNEL_ATTRIBUTION_SECRET;
	else process.env.CHANNEL_ATTRIBUTION_SECRET = originalSecret;
});

function token(channel = "sui", issued = 1000, expires = 1900): string {
	const nonce = "n".repeat(22);
	const signature = createHmac("sha256", SECRET)
		.update(`clawdi/channel-trial/v1|${channel}|${issued}|${expires}|${nonce}`)
		.digest("base64url");
	return `v1.${channel}.${issued}.${expires}.${nonce}.${signature}`;
}

function capture(search: string, channel = "sui"): Response {
	process.env.CHANNEL_ATTRIBUTION_SECRET = SECRET;
	clock = spyOn(Date, "now").mockReturnValue(1_100_000);
	return captureChannelAttribution(
		new Request(`https://cloud.example/attribution/${channel}?${search}`),
		channel,
	);
}

describe("trusted channel invitations", () => {
	test("matches the Python protocol and rejects expiry, tampering and unsupported channels", () => {
		expect(token()).toBe(VECTOR);
		expect(verifyChannelAttribution(VECTOR, SECRET, 1100)).toEqual({
			channel: "sui",
			expiresAt: 1900,
			token: VECTOR,
		});
		for (const invalid of [
			`${VECTOR}A`,
			token("other"),
			token("sui", 1000, 1901),
			token("sui", 1200, 2100),
			"x".repeat(513),
			null,
		]) {
			expect(verifyChannelAttribution(invalid, SECRET, 1100)).toBeNull();
		}
		expect(verifyChannelAttribution(VECTOR, SECRET, 1900)).toBeNull();
		expect(capture(`token=${VECTOR}`, "other").status).toBe(400);
		for (const key of [undefined, "short", "x".repeat(32)]) {
			expect(verifyChannelAttribution(VECTOR, key, 1100)).toBeNull();
		}
	});

	test("exchanges the bearer before rendering scripts, with fixed redirect and protected cookie", async () => {
		const response = capture(`token=${VECTOR}`);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/deploy");
		expect(response.headers.get("set-cookie")).toBe(
			`${CHANNEL_ATTRIBUTION_COOKIE}=${VECTOR}; Max-Age=800; Path=/; HttpOnly; Secure; SameSite=Lax`,
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await response.text()).toBe("");
	});

	test("rejects duplicate parameters and arbitrary redirects without setting a cookie", async () => {
		for (const search of [
			`token=${VECTOR}&token=${VECTOR}`,
			`token=${VECTOR}&target=deploy&target=deploy`,
			`token=${VECTOR}&target=https://evil.example`,
			`token=${VECTOR}A`,
			"utm_source=sui",
		]) {
			const response = capture(search);
			expect(response.status).toBe(400);
			expect(response.headers.has("set-cookie")).toBe(false);
			expect(response.headers.has("location")).toBe(false);
			expect(await response.text()).not.toContain(VECTOR);
			clock?.mockRestore();
		}
	});
});
