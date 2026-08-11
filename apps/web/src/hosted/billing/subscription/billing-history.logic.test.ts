import { describe, expect, test } from "bun:test";
import { billingHistoryEmptyStateCopy, billingHistoryFundingLabel } from "./billing-history.logic";

describe("billingHistoryFundingLabel", () => {
	test("names the wallet settlement without hiding the Stripe invoice", () => {
		expect(billingHistoryFundingLabel("wallet")).toBe("Paid from Wallet");
		expect(billingHistoryFundingLabel("stripe")).toBe("Paid by card");
	});
});

describe("billingHistoryEmptyStateCopy", () => {
	test("keeps provider continuation reachable through an empty display page", () => {
		expect(billingHistoryEmptyStateCopy(true)).toEqual({
			title: "No matching invoices on this page",
			description: "Load more to check older billing history.",
		});
	});

	test("uses the terminal empty state after provider pagination ends", () => {
		expect(billingHistoryEmptyStateCopy(false)).toEqual({
			title: "No billing history yet",
			description: "Paid compute invoices will appear here after the first collection.",
		});
	});
});
