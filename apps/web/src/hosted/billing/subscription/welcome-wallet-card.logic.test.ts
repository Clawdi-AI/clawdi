import { describe, expect, test } from "bun:test";
import { welcomeWalletDescription } from "@/hosted/billing/subscription/welcome-wallet-card.logic";

describe("welcomeWalletDescription", () => {
	test("describes an applied grant using its transaction amount", () => {
		expect(
			welcomeWalletDescription({
				grantApplied: true,
				grantPending: false,
				grantCheckTimedOut: false,
				grantAmount: "$5.00",
			}),
		).toBe("Your $5.00 welcome balance is available in your Wallet.");
	});

	test("preserves unavailable, pending, and delayed grant feedback", () => {
		const unavailable = welcomeWalletDescription({
			grantApplied: false,
			grantPending: false,
			grantCheckTimedOut: false,
			grantAmount: null,
		});
		const pending = welcomeWalletDescription({
			grantApplied: false,
			grantPending: true,
			grantCheckTimedOut: false,
			grantAmount: "$5.00",
		});
		const delayed = welcomeWalletDescription({
			grantApplied: false,
			grantPending: true,
			grantCheckTimedOut: true,
			grantAmount: "$5.00",
		});

		expect(unavailable).toBe("Your Wallet is ready.");
		expect(pending).toBe("Your $5.00 welcome balance is on the way.");
		expect(delayed).toBe("It hasn’t appeared yet. Refresh to check again.");
	});
});
