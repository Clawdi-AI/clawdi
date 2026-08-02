import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type GlobalWalletBalanceView =
	typeof import("@/hosted/global-wallet-balance").GlobalWalletBalanceView;
type HostedWalletBalanceApplicable =
	typeof import("@/hosted/global-wallet-balance").hostedWalletBalanceApplicable;

let globalWalletBalanceView: GlobalWalletBalanceView | null = null;
let walletBalanceApplicable: HostedWalletBalanceApplicable | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/global-wallet-balance");
	globalWalletBalanceView = module.GlobalWalletBalanceView;
	walletBalanceApplicable = module.hostedWalletBalanceApplicable;
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
	});
});

describe("global Wallet balance presentation", () => {
	test("renders a real balance as the compact global action", () => {
		if (!globalWalletBalanceView) throw new Error("global Wallet balance was not loaded");
		const markup = renderToStaticMarkup(
			createElement(globalWalletBalanceView, { state: "ready", balanceUsd: "1250.5" }),
		);

		expect(markup).toContain("$1,250.50");
		expect(markup).toContain("Wallet balance $1,250.50. Open Wallet settings");
		expect(markup).toContain('data-testid="global-wallet-balance"');
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
		expect(loading).toContain("Wallet balance loading");
		expect(unavailable).toContain("Wallet balance unavailable");
		expect(`${loading}${unavailable}`).not.toContain("$0");
	});
});
