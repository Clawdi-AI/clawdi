import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
	trustworthyWalletBalanceUsd,
	WalletDebitEquation,
} from "@/hosted/billing/components/wallet-debit-equation";
import { walletPlanChangeDecision } from "@/hosted/billing/subscription/plan-change-dialog";

const planChangeSource = readFileSync(
	new URL("../subscription/plan-change-dialog.tsx", import.meta.url),
	"utf8",
);
const agentDetailSource = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);

describe("WalletDebitEquation availability", () => {
	test("shows the shared Wallet retry panel without a cached balance after a read error", () => {
		const html = renderToStaticMarkup(
			<WalletDebitEquation
				balanceBeforeUsd={null}
				debitAmountUsd="25"
				balanceAfterUsd={null}
				balanceError={new Error("Wallet read failed")}
				onRetryBalance={() => undefined}
			/>,
		);

		expect(html).toContain("Couldn&#x27;t load your Wallet balance");
		expect(html).toContain("Retry");
		expect(html).not.toContain("Balance before");
		expect(html).not.toContain("$100.00");
	});

	test("does not treat cached data as trustworthy while refetching", () => {
		expect(
			trustworthyWalletBalanceUsd({ balanceUsd: "100", error: null, isFetching: true }),
		).toBeNull();
		expect(
			walletPlanChangeDecision({
				fundingSource: "wallet",
				changeKind: "immediate_upgrade",
				amountUsd: "25",
				balanceUsd: "100",
				balanceError: null,
				isBalanceFetching: true,
			}),
		).toMatchObject({
			trustedBalanceUsd: null,
			balanceAfterUsd: null,
			walletInsufficient: false,
			balanceReadUnavailable: true,
		});
	});
});

describe("plan-change Wallet decision", () => {
	test("does not compute sufficiency from a cached balance after wallet.error", () => {
		const decision = walletPlanChangeDecision({
			fundingSource: "wallet",
			changeKind: "immediate_upgrade",
			amountUsd: "25",
			balanceUsd: "100",
			balanceError: new Error("background refetch failed"),
			isBalanceFetching: false,
		});

		expect(decision).toEqual({
			trustedBalanceUsd: null,
			balanceAfterUsd: null,
			walletInsufficient: false,
			balanceReadUnavailable: true,
		});
		expect(planChangeSource).toContain("walletDecision.balanceReadUnavailable");
		expect(agentDetailSource).toContain(
			"wallet.error || wallet.isFetching ? null : (wallet.data?.balance_usd ?? null)",
		);
	});
});
