import { describe, expect, test } from "bun:test";
import { billingHistoryFundingLabel } from "./billing-history.logic";

describe("billingHistoryFundingLabel", () => {
	test("names the wallet settlement without hiding the Stripe invoice", () => {
		expect(billingHistoryFundingLabel("wallet")).toBe("Paid with AI Credits");
		expect(billingHistoryFundingLabel("stripe")).toBe("Paid by card");
	});
});
