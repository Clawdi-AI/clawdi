import { describe, expect, test } from "bun:test";
import { lowBalanceBannerView } from "./low-balance-banner";

const card = { hasWalletCompute: false, cardBilling: true };
const declined = { attempt_id: 1, payment_intent_id: "pi_1", error_code: "card_declined" };
const awaitingBank = { attempt_id: 1, payment_intent_id: "pi_1", error_code: null };

describe("lowBalanceBannerView", () => {
	test("hidden without a wallet or with a healthy balance and no action", () => {
		expect(lowBalanceBannerView(undefined, card)).toBeNull();
		expect(lowBalanceBannerView({ balance_usd: "50" }, card)).toBeNull();
	});

	test("a low balance asks for a top-up or auto-reload", () => {
		expect(lowBalanceBannerView({ balance_usd: "1" }, card)).toEqual({
			tone: "default",
			title: "Your wallet balance is running low",
			body: "You have about $1.00 left. Top up or turn on auto-reload to keep Clawdi AI running.",
			hasAction: false,
			declined: false,
		});
	});

	test("wallet-funded compute is named as at risk", () => {
		expect(
			lowBalanceBannerView({ balance_usd: "1" }, { ...card, hasWalletCompute: true })?.body,
		).toBe(
			"You have about $1.00 left. Top up or turn on auto-reload to keep Clawdi AI and wallet-funded compute running.",
		);
	});

	test("a pending bank confirmation shows even with a healthy balance", () => {
		expect(
			lowBalanceBannerView({ balance_usd: "50", auto_reload_action: awaitingBank }, card),
		).toMatchObject({
			tone: "default",
			title: "Your bank needs to confirm a top-up",
			hasAction: true,
			declined: false,
		});
	});

	test("a declined auto-reload is destructive", () => {
		expect(
			lowBalanceBannerView({ balance_usd: "50", auto_reload_action: declined }, card),
		).toMatchObject({
			tone: "destructive",
			title: "Auto-reload was declined",
			hasAction: true,
			declined: true,
		});
	});

	test("without card billing, auto-reload states and copy are omitted", () => {
		const store = { hasWalletCompute: false, cardBilling: false };
		expect(
			lowBalanceBannerView({ balance_usd: "50", auto_reload_action: declined }, store),
		).toBeNull();
		expect(lowBalanceBannerView({ balance_usd: "1", auto_reload_action: declined }, store)).toEqual(
			{
				tone: "default",
				title: "Your wallet balance is running low",
				body: "You have about $1.00 left. Top up to keep Clawdi AI running.",
				hasAction: false,
				declined: false,
			},
		);
	});
});
