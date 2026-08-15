import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type GlobalWalletBalanceView =
	typeof import("@/hosted/global-wallet-balance").GlobalWalletBalanceView;
type HeaderWalletBalanceApplicable =
	typeof import("@/hosted/global-wallet-balance").headerWalletBalanceApplicable;

let globalWalletBalanceView: GlobalWalletBalanceView | null = null;
let walletBalanceApplicable: HeaderWalletBalanceApplicable | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/global-wallet-balance");
	globalWalletBalanceView = module.GlobalWalletBalanceView;
	walletBalanceApplicable = module.headerWalletBalanceApplicable;
});

describe("global Wallet balance applicability", () => {
	test("shows only for accounts with Cloud billing access or existing Cloud deployments", () => {
		if (!walletBalanceApplicable) throw new Error("global Wallet balance was not loaded");

		expect(
			walletBalanceApplicable({ canCreateCloudAgents: true, existingCloudDeploymentCount: 0 }),
		).toBe(true);
		expect(
			walletBalanceApplicable({ canCreateCloudAgents: false, existingCloudDeploymentCount: 2 }),
		).toBe(true);
		expect(
			walletBalanceApplicable({ canCreateCloudAgents: false, existingCloudDeploymentCount: 0 }),
		).toBe(false);
		expect(
			walletBalanceApplicable({ canCreateCloudAgents: false, existingCloudDeploymentCount: null }),
		).toBe(false);
	});
});

describe("global Wallet balance presentation", () => {
	test("renders a real balance as the compact global action", () => {
		if (!globalWalletBalanceView) throw new Error("global Wallet balance was not loaded");
		const markup = renderToStaticMarkup(
			createElement(globalWalletBalanceView, {
				state: "ready",
				balanceUsd: "1250.5",
				onOpenWallet: () => undefined,
			}),
		);

		expect(markup).toContain("$1,250.50");
		expect(markup).toContain("Wallet balance $1,250.50. Open Wallet settings");
		expect(markup).toContain('title="Wallet balance $1,250.50. Open Wallet settings"');
		expect(markup).toContain('data-testid="global-wallet-balance"');
		expect(markup).toContain("lucide-wallet-cards");
		expect(markup).not.toMatch(/>\s*Wallet\s*</);
	});

	test("uses a compact skeleton while loading and never invents a zero balance", () => {
		if (!globalWalletBalanceView) throw new Error("global Wallet balance was not loaded");
		const loading = renderToStaticMarkup(
			createElement(globalWalletBalanceView, { state: "loading" }),
		);
		const unavailable = renderToStaticMarkup(
			createElement(globalWalletBalanceView, { state: "unavailable" }),
		);

		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).toContain("disabled");
		expect(loading).toContain("Wallet balance loading");
		expect(unavailable).toContain("Wallet balance unavailable");
		expect(loading).toContain("lucide-wallet-cards");
		expect(unavailable).toContain("lucide-wallet-cards");
		expect(unavailable).not.toContain('data-slot="skeleton"');
		expect(`${loading}${unavailable}`).not.toContain("$0");
		expect(`${loading}${unavailable}`).not.toMatch(/>\s*Wallet\s*</);
	});
});
