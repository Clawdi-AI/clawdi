import { describe, expect, test } from "bun:test";
import type { WalletStatusGateway } from "../../src/commands/wallet";
import { walletStatusCommand } from "../../src/commands/wallet";

describe("wallet status command", () => {
	test("reads the authenticated Wallet snapshot and verified binding", async () => {
		const calls: string[] = [];
		const client: WalletStatusGateway = {
			async getWallet() {
				calls.push("wallet");
				return {
					balance_usd: "12.50",
					x402_enabled: true,
					x402_payment_authority: {
						api_origin: "https://api.example.test",
						pay_to: `0x${"2".repeat(40)}`,
						amount_atomic: "5000000",
					},
					x402_payment_status: "idle",
					auto_reload_enabled: false,
					auto_reload_has_payment_method: false,
					auto_reload_card: null,
					auto_reload_currency: "usd",
					auto_reload_threshold_usd: null,
					auto_reload_amount_usd: null,
				};
			},
			async getWalletBinding() {
				calls.push("binding");
				return {
					bound: true,
					address: `0x${"1".repeat(40)}`,
					verified_at: "2026-08-16T12:00:00Z",
				};
			},
		};
		const output: string[] = [];

		await walletStatusCommand(
			{ json: true },
			{ client, writeStdout: (value) => output.push(value) },
		);

		expect(calls.sort()).toEqual(["binding", "wallet"]);
		expect(JSON.parse(output[0] ?? "")).toMatchObject({
			balance_usd: "12.50",
			x402_payment_status: "idle",
			x402_payment_attempt: null,
			binding: { bound: true, address: `0x${"1".repeat(40)}` },
		});
	});
});
