import { describe, expect, test } from "bun:test";
import { deploySubmissionErrorCopy } from "./deploy-submission-error";

describe("Deploy CTA copy", () => {
	const noPayment = "No wallet payment was made";
	const unconfirmed = "We couldn’t confirm the payment — check status before trying again.";

	test("only a definitive refusal of the first send says no wallet payment was made", () => {
		expect(
			deploySubmissionErrorCopy(
				{ kind: "rejected", recovery: null, firstSend: true },
				"wallet_creation",
			).description,
		).toContain(noPayment);
		for (const firstSend of [false, undefined])
			expect(
				deploySubmissionErrorCopy(
					{ kind: "rejected", recovery: null, firstSend },
					"wallet_creation",
				).description,
			).toBe(unconfirmed);
		for (const kind of ["timeout", "offline", "server", "unknown"] as const)
			expect(
				deploySubmissionErrorCopy({ kind, recovery: null, firstSend: true }, "wallet_creation")
					.description,
			).not.toContain(noPayment);
	});

	test("acceptance pending after a funded checkout never reads as nothing happened", () => {
		const copy = deploySubmissionErrorCopy(
			{ kind: "rejected", recovery: null, code: "deployment_acceptance_pending", firstSend: true },
			"wallet_creation",
		);
		expect(copy.title).toBe("Your payment may have gone through");
		expect(copy.description).not.toContain(noPayment);
	});
});
