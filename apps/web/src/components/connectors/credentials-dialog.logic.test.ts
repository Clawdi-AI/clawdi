import { describe, expect, test } from "bun:test";
import {
	buildCredentialPayload,
	getVisibleCredentialFields,
	shouldShowCredentialField,
} from "./credentials-dialog.logic";

describe("credential field visibility", () => {
	test("shows customer-facing fields", () => {
		expect(
			shouldShowCredentialField({
				name: "apiKey",
				required: true,
				expected_from_customer: true,
			}),
		).toBe(true);
	});

	test("shows required non-customer fields when no default exists", () => {
		expect(
			shouldShowCredentialField({
				name: "subdomain",
				required: true,
				expected_from_customer: false,
				default: null,
			}),
		).toBe(true);
	});

	test("hides non-customer fields when defaults can be submitted", () => {
		expect(
			shouldShowCredentialField({
				name: "baseUrl",
				required: true,
				expected_from_customer: false,
				default: "https://api.example.test",
			}),
		).toBe(false);
	});

	test("includes hidden defaults in submitted credentials", () => {
		expect(
			buildCredentialPayload(
				[
					{
						name: "baseUrl",
						required: true,
						expected_from_customer: false,
						default: " https://api.example.test ",
					},
					{ name: "apiKey", required: true, expected_from_customer: true },
				],
				{ apiKey: " token_123 " },
			),
		).toEqual({
			apiKey: "token_123",
			baseUrl: "https://api.example.test",
		});
	});

	test("keeps required non-customer fields visible alongside API keys", () => {
		const fields = getVisibleCredentialFields([
			{
				name: "subdomain",
				required: true,
				expected_from_customer: false,
				default: null,
			},
			{ name: "apiKey", required: true, expected_from_customer: true },
		]);

		expect(fields.map((field) => field.name)).toEqual(["subdomain", "apiKey"]);
	});
});
