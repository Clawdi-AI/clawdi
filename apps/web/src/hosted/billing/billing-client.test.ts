import { describe, expect, it } from "bun:test";
import { hostedV2ApiBaseUrl } from "@/hosted/billing/billing-url";

describe("hostedV2ApiBaseUrl", () => {
	it("adds the v2 prefix to a deploy API origin", () => {
		expect(hostedV2ApiBaseUrl("https://api.clawdi.ai")).toBe("https://api.clawdi.ai/v2");
	});

	it("does not duplicate an existing v2 prefix", () => {
		expect(hostedV2ApiBaseUrl("https://api.clawdi.ai/v2/")).toBe("https://api.clawdi.ai/v2");
	});

	it("preserves non-v2 base paths before adding the v2 prefix", () => {
		expect(hostedV2ApiBaseUrl("https://example.com/backend")).toBe(
			"https://example.com/backend/v2",
		);
	});
});
