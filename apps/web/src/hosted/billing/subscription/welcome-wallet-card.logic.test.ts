import { describe, expect, test } from "bun:test";
import { welcomeWalletDescription } from "@/hosted/billing/subscription/welcome-wallet-card.logic";

describe("welcomeWalletDescription", () => {
	test("explains the funding order when deployment is available", () => {
		expect(
			welcomeWalletDescription({
				grantApplied: true,
				grantPending: false,
				grantCheckTimedOut: false,
				grantAmount: "$5.00",
				showDeployAction: true,
			}),
		).toContain(
			"welcome balance covers Managed AI first; after that, usage draws from your Wallet.",
		);
	});

	test("does not advertise deployment when the account has no deploy action", () => {
		const unavailable = welcomeWalletDescription({
			grantApplied: false,
			grantPending: false,
			grantCheckTimedOut: false,
			grantAmount: "$5.00",
			showDeployAction: false,
		});
		const pending = welcomeWalletDescription({
			grantApplied: false,
			grantPending: true,
			grantCheckTimedOut: false,
			grantAmount: "$5.00",
			showDeployAction: false,
		});

		expect(unavailable).toBe("Your Wallet is ready.");
		expect(pending).toBe("Your $5.00 welcome balance is on the way.");
		expect(`${unavailable} ${pending}`).not.toContain("deploy");
	});
});
