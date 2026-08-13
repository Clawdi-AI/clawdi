import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	FundingSourceSwitchSummary,
	PaymentMethodRequiredRecovery,
	planChangeDialogStep,
	planChangeManagementModes,
} from "./plan-change-dialog";

test("falls back to payment source management when plan offers are unavailable", () => {
	expect(
		planChangeManagementModes({
			allowCombinedChange: false,
			paymentSourceOnly: false,
			hasUsablePlans: false,
		}),
	).toEqual({
		hasModePicker: true,
		initialMode: "payment-source",
		planBillingAvailable: false,
	});
});

describe("funding source switch quote", () => {
	test("shows zero due now and future-renewal semantics without debit copy", () => {
		const markup = renderToStaticMarkup(
			<FundingSourceSwitchSummary amountCents={0} fundingSource="wallet" />,
		);

		expect(markup).toContain("Due now");
		expect(markup).toContain("$0.00");
		expect(markup).toContain("Future renewals use Wallet");
		expect(markup).toContain("does not debit your Wallet today");
		expect(markup).not.toContain("Wallet balance");
		expect(markup).not.toContain("proration");
	});
});

describe("payment method recovery", () => {
	test("offers the portal without a quote and requires a fresh submission", () => {
		expect(
			planChangeDialogStep({
				hasAcceptedChange: false,
				hasQuote: false,
				paymentMethodRequired: true,
			}),
		).toBe("payment_method_required");
		const markup = renderToStaticMarkup(
			<PaymentMethodRequiredRecovery
				isManagingPaymentMethods={false}
				onClose={() => undefined}
				onManagePaymentMethods={() => undefined}
			/>,
		);

		expect(markup).toContain("Manage payment methods");
		expect(markup).toContain("does not complete this payment source change");
		expect(markup).toContain("request a fresh quote and submit it again");
		expect(markup).not.toContain("Update payment source");
		expect(markup).not.toContain("Confirm upgrade");
	});
});
