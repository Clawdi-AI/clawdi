import { expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Subscription, Transaction } from "@/hosted/billing/format";
import { storeSurfaces } from "@/platform/store/store-policy";

// React Native cannot load under Bun: render the store-build surfaces with plain primitives.
// `test:internal` runs each file with `--isolate`, so these module mocks stay in this file.
const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
for (const icon of [
	"calendar-x-2",
	"circle-check",
	"coins",
	"credit-card",
	"external-link",
	"link-2-off",
	"refresh-cw",
	"settings",
	"triangle-alert",
	"user-round-x",
])
	mock.module(`lucide-react-native/icons/${icon}`, () => ({ default: none }));
mock.module("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
mock.module("expo-router", () => ({
	router: { push: () => undefined },
	useRouter: () => ({ push: () => undefined }),
}));
mock.module("expo-web-browser", () => ({ openBrowserAsync: async () => undefined }));
mock.module("@/components/agent-framework-icon", () => ({ AgentFrameworkIcon: none }));
mock.module("@/components/dashboard/agent-icon", () => ({ AgentIcon: none }));
mock.module("@/components/ui/alert", () => ({
	Alert: ({ title, children }: { title?: ReactNode; children?: ReactNode }) => (
		<>
			{title}
			{children}
		</>
	),
}));
mock.module("@/components/ui/confirm-action", () => ({ ConfirmAction: passthrough }));
mock.module("@/components/entity-card", () => ({ EntityCardChassis: passthrough }));
mock.module("@/components/ui/badge", () => ({ Badge: passthrough }));
mock.module("@/components/ui/button", () => ({ Button: passthrough }));
mock.module("@/components/ui/card", () => ({ Card: passthrough, CardContent: passthrough }));
mock.module("@/components/ui/icon", () => ({ Icon: none }));
mock.module("@/components/ui/status-badge", () => ({ StatusBadge: passthrough }));
mock.module("@/components/ui/text", () => ({ Text: passthrough }));
mock.module("@/components/ui/view", () => ({ AppPressable: passthrough, AppView: passthrough }));
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
mock.module("@/hosted/billing/store/compute-store", () => ({
	StoreSubscriptionActions: none,
	StoreSubscriptionNotice: none,
}));
mock.module("@/lib/api-provider", () => ({ useMobileApi: () => ({ compute: {} }) }));
mock.module("@/platform/account-lifecycle", () => ({
	accountQueryKey: (_scope: unknown, key: string) => [key],
	useAccountRead: () => async () => undefined,
	useAccountScope: () => ({ identity: {}, isCurrent: () => true, signal: { aborted: false } }),
}));
mock.module("@/platform/auth/use-auth-action", () => ({
	useAuthAction: () => ({ busy: false, error: null, run: async () => undefined }),
}));
mock.module("@/platform/store/paywall-host", () => ({ usePaywall: () => null }));
mock.module("@/platform/store/revenuecat", () => ({ loadCreditsOffering: async () => null }));
mock.module("@/platform/store/store-provider", () => ({
	// A production store build with purchases unavailable.
	useMobileStore: () => ({ creditsAvailable: false, flow: null, storeBuild: true }),
	useStoreSurfaces: () => storeSurfaces(true, false),
}));
mock.module("@/platform/use-foreground-lease", () => ({
	useForegroundLease: () => () => () => true,
}));
mock.module("@/platform/use-refresh-on-focus", () => ({ useRefreshOnFocus: () => undefined }));

const { useHeaderWalletBalance } = await import("@/hosted/global-wallet-balance");
const { WalletDebitEquation } = await import("@/hosted/billing/components/wallet-debit-equation");
const { LowBalanceBanner } = await import("@/hosted/billing/components/low-balance-banner");
const { SubscriptionRow } = await import("@/hosted/billing/subscription/subscription-row");
const { BalanceCard } = await import("@/hosted/billing/wallet/balance-card");
const { TransactionRow } = await import("@/hosted/billing/wallet/transactions-section");

/** Credits as a unit, e.g. `10.00 credits`. */
const creditUnit = /\d\s*credits/i;

function Row() {
	return (
		<SubscriptionRow
			item={subscription}
			reusableSubscriptionIds={new Set()}
			reusableInventoryUncertain={false}
		/>
	);
}

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
		renderToStaticMarkup(<Row />),
	];
	const [header, balance, row, equation, card] = markup;
	expect(header).toBe("$10.00|Wallet balance $10.00. Open Wallet settings");
	expect(balance).toContain("$10.00");
	// The store purchase entry uses Web's Top up label.
	expect(balance).toContain("Top up");
	expect(row).toContain("−$19.88");
	expect(equation).toContain("$19.88");
	expect(equation).toContain("$10.00 minus $19.88 equals");
	expect(card).toContain("$19.88/mo");
	for (const html of markup) expect(html).not.toMatch(creditUnit);
});

test("store builds never mention card payments on the Wallet", () => {
	const markup = [
		renderToStaticMarkup(<HeaderBalance />),
		renderToStaticMarkup(<BalanceCard wallet={{ balance_usd: "10" }} />),
		renderToStaticMarkup(<BalanceCard wallet={{ balance_usd: "0.5" }} />),
		renderToStaticMarkup(
			<LowBalanceBanner
				wallet={{
					balance_usd: "0.5",
					auto_reload_action: {
						attempt_id: 1,
						payment_intent_id: "pi_1",
						client_secret: "pi_1_secret",
						error_code: "declined",
					},
				}}
				hasWalletCompute={false}
			/>,
		),
		renderToStaticMarkup(<TransactionRow item={transaction} />),
		renderToStaticMarkup(<Row />),
	];
	expect(markup[1]).toContain("Pays for AI usage and wallet-funded compute subscriptions.");
	// Web's low-balance banner without the auto-reload states, which need a saved card.
	expect(markup[3]).toContain("You have about $0.50 left. Top up to keep Clawdi AI running.");
	for (const html of markup) {
		expect(html).not.toMatch(/auto-reload/i);
		expect(html).not.toContain("Card-paid subscriptions do not use this balance.");
		expect(html).not.toMatch(/\bcards?\b|card-paid/i);
	}
});
