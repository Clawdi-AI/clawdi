import { describe, expect, test } from "bun:test";
import {
	providerConnectionIssueMessage,
	providerConnectionIssueTitle,
} from "@/hosted/v2/ai-providers/provider-connection-feedback";

describe("provider connection feedback", () => {
	test("turns typed failure categories into actionable copy", () => {
		const error = {
			category: "authentication" as const,
			code: "invalid_api_key",
			message: "upstream tenant=internal api_key=must-not-render",
			retryable: false,
		};

		expect(providerConnectionIssueTitle(error)).toBe("Authentication");
		expect(providerConnectionIssueMessage(error)).toBe(
			"The provider rejected the API key. Check it and try again.",
		);
		expect(providerConnectionIssueMessage(error)).not.toContain(error.message);
	});

	test("keeps an internal-free fallback when no structured error is present", () => {
		expect(providerConnectionIssueTitle(null)).toBe("Connection");
		expect(providerConnectionIssueMessage(null)).toBe(
			"The provider did not accept the test request.",
		);
	});
});
