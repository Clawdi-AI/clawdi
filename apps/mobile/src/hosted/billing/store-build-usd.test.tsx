import { expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Subscription, Transaction } from "@/hosted/billing/format";
import { storeSurfaces } from "@/platform/store/store-policy";

// React Native cannot load under Bun: render the store-build surfaces with plain primitives.
// `test:internal` runs each file with `--isolate`, so these module mocks stay in this file.
const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
for (const icon of ["coins", "credit-card", "external-link", "triangle-alert"])
	mock.module(`lucide-react-native/icons/${icon}`, () => ({ default: none }));
mock.module("expo-router", () => ({ router: { push: () => undefined } }));
mock.module("expo-web-browser", () => ({ openBrowserAsync: async () => undefined }));
mock.module("@/components/agent-framework-icon", () => ({ AgentFrameworkIcon: none }));
mock.module("@/components/entity-card", () => ({ EntityCardChassis: passthrough }));
mock.module("@/components/ui/badge", () => ({ Badge: passthrough }));
mock.module("@/components/ui/button", () => ({ Button: passthrough }));
mock.module("@/components/ui/card", () => ({ Card: passthrough, CardContent: passthrough }));
mock.module("@/components/ui/icon", () => ({ Icon: none }));
mock.module("@/components/ui/status-badge", () => ({ StatusBadge: passthrough }));
mock.module("@/components/ui/text", () => ({ Text: passthrough }));
mock.module("@/components/ui/web-layout", () => ({
	WebText: passthrough,
	WebView: ({
		accessibilityLabel,
		children,
	}: {
		accessibilityLabel?: string;
		children?: ReactNode;
	}) => (
		<>
			{accessibilityLabel}
			{children}
		</>
	),
	webView: () => "",
}));
mock.module("@/hooks/use-dashboard-agents", () => ({
	useDashboardAgents: () => ({ inventory: { data: [] }, tiles: [] }),
}));
mock.module("@/hosted/billing/hooks", () => ({
	useWallet: () => ({ isPending: false, data: { balance_usd: "10" } }),
}));
mock.module("@/hosted/billing/store/add-credits", () => ({
	AddCreditsAction: () => <>Add credits</>,
	CheckPendingPurchasesAction: none,
}));
mock.module("@/hosted/billing/store/compute-store", () => ({ StoreSubscriptionNotice: none }));
mock.module("@/lib/api-provider", () => ({ useMobileApi: () => ({ compute: {} }) }));
mock.module("@/platform/account-lifecycle", () => ({
	accountQueryKey: (_scope: unknown, key: string) => [key],
	useAccountScope: () => ({ identity: {}, isCurrent: () => true, signal: { aborted: false } }),
}));
mock.module("@/platform/auth/use-auth-action", () => ({
	useAuthAction: () => ({ busy: false, error: null, run: async () => undefined }),
}));
mock.module("@/platform/store/store-provider", () => ({
	// A production store build with purchases unavailable.
	useStoreSurfaces: () => storeSurfaces(true, false),
}));
mock.module("@/platform/use-foreground-lease", () => ({
	useForegroundLease: () => () => () => true,
}));
mock.module("@/platform/use-refresh-on-focus", () => ({ useRefreshOnFocus: () => undefined }));

const { useHeaderWalletBalance } = await import("@/hosted/global-wallet-balance");
const { WalletDebitEquation } = await import("@/hosted/billing/components/wallet-debit-equation");
const { ComputeSubscriptionCard } = await import(
	"@/hosted/billing/subscription/compute-subscription-card"
);
const { BalanceCard } = await import("@/hosted/billing/wallet/balance-card");
const { TransactionRow } = await import("@/hosted/billing/wallet/transactions-section");

/** Credits as a unit, e.g. `10.00 credits`; "Add credits" names the purchase. */
const creditUnit = /\d\s*credits/i;

function HeaderBalance() {
	const header = useHeaderWalletBalance();
	return (
		<>
			{header?.label}|{header?.accessibilityLabel}
		</>
	);
}

const transaction = {
	id: "txn-1",
	kind: "compute_subscription",
	occurred_at: "2026-10-10T12:00:00Z",
	amount: "19.88",
	currency: "usd",
	direction: "debit",
	status: "succeeded",
	funding: "wallet",
} satisfies Transaction;

const subscription = {
	subscription_id: "sub-1",
	subscription_kind: "paid",
	plan_slug: "compute_basic",
	funding_source: "wallet",
	status: "active",
	price_cents: 1988,
	currency: "usd",
	billing_term_months: 1,
	cancel_at_period_end: false,
	agent_name: null,
	is_orphan: false,
	payment_state: "ok",
	latest_failed_invoice_hosted_url: null,
	next_payment_attempt_at: null,
	recovery_action: null,
	pending_plan_slug: null,
} satisfies Subscription;

test("store builds show Wallet amounts and wallet-funded prices in USD, like Web", () => {
	const markup = [
		renderToStaticMarkup(<HeaderBalance />),
		renderToStaticMarkup(<BalanceCard wallet={{ balance_usd: "10" }} />),
		renderToStaticMarkup(<TransactionRow item={transaction} />),
		renderToStaticMarkup(
			<WalletDebitEquation
				debit={{ balanceBeforeUsd: "10", debitAmountUsd: "19.88", balanceAfterUsd: "-9.88" }}
			/>,
		),
		renderToStaticMarkup(<ComputeSubscriptionCard item={subscription} />),
	];
	const [header, balance, row, equation, card] = markup;
	expect(header).toBe("$10.00|Wallet balance $10.00. Open Wallet settings");
	expect(balance).toContain("$10.00");
	// The store purchase entry keeps its name.
	expect(balance).toContain("Add credits");
	expect(row).toContain("−$19.88");
	expect(equation).toContain("$19.88");
	expect(equation).toContain("$10.00 minus $19.88 equals");
	expect(card).toContain("$19.88/mo");
	for (const html of markup) expect(html).not.toMatch(creditUnit);
});
