import type { HostedDeployWallet, HostedWalletBinding } from "@clawdi/shared/api";
import { HostedDeployApiError, HostedDeployClient } from "../lib/hosted-deploy-client";
import { isInteractive } from "../lib/tty";

export type WalletStatusOptions = { json?: boolean };

export interface WalletStatusGateway {
	getWallet(): Promise<HostedDeployWallet>;
	getWalletBinding(): Promise<HostedWalletBinding>;
}

export type WalletStatusDependencies = {
	client?: WalletStatusGateway;
	interactive?: boolean;
	writeStdout?: (value: string) => void;
};

export class WalletStatusError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WalletStatusError";
		this.code = code;
	}
}

function bindingAddress(binding: HostedWalletBinding): string | null {
	if (!binding.bound) {
		if (binding.address) throw invalidHostedResponse();
		return null;
	}
	if (!binding.address || !/^0x[0-9a-fA-F]{40}$/.test(binding.address)) {
		throw invalidHostedResponse();
	}
	return binding.address;
}

function invalidHostedResponse(): WalletStatusError {
	return new WalletStatusError(
		"invalid_hosted_response",
		"Hosted returned an invalid Wallet response.",
	);
}

export async function walletStatusCommand(
	options: WalletStatusOptions = {},
	dependencies: WalletStatusDependencies = {},
): Promise<void> {
	const client = dependencies.client ?? new HostedDeployClient();
	const [wallet, binding] = await Promise.all([client.getWallet(), client.getWalletBinding()]);
	const address = bindingAddress(binding);
	const fundingStatus =
		wallet.x402_payment_attempt?.status ??
		(wallet.x402_enabled || wallet.x402_payment_status !== "idle"
			? wallet.x402_payment_status
			: "unavailable");
	const result = {
		schema_version: "clawdi.wallet.status.v1",
		balance_usd: wallet.balance_usd,
		x402_enabled: wallet.x402_enabled,
		x402_payment_status: wallet.x402_payment_status,
		x402_payment_attempt: wallet.x402_payment_attempt ?? null,
		x402_payment_authority: wallet.x402_payment_authority,
		binding: {
			bound: binding.bound,
			address,
			verified_at: binding.verified_at ?? null,
		},
	};
	(dependencies.writeStdout ?? console.log)(
		options.json
			? JSON.stringify(result, null, 2)
			: [
					`Wallet balance: $${wallet.balance_usd}`,
					`USDC funding: ${fundingStatus}`,
					`Verified wallet: ${address ?? "not bound"}`,
				].join("\n"),
	);
}

function safeWalletStatusError(error: unknown): { code: string; message: string } {
	if (error instanceof WalletStatusError) return { code: error.code, message: error.message };
	if (error instanceof HostedDeployApiError) {
		if (error.status === 401) {
			return { code: "hosted_auth_required", message: "Hosted CLI authorization was rejected." };
		}
		if (error.status === 403) {
			return { code: "hosted_forbidden", message: "This account cannot access Hosted Wallet." };
		}
		return {
			code:
				error.status >= 500 || error.status === 0 ? "hosted_unavailable" : "hosted_wallet_error",
			message:
				error.status >= 500 || error.status === 0
					? "Hosted Wallet is temporarily unavailable."
					: "Hosted rejected the Wallet request.",
		};
	}
	return { code: "wallet_status_failed", message: "Wallet status could not be loaded." };
}

export async function runWalletStatusCommand(
	options: WalletStatusOptions,
	dependencies: WalletStatusDependencies = {},
): Promise<void> {
	try {
		await walletStatusCommand(options, dependencies);
	} catch (error) {
		const safe = safeWalletStatusError(error);
		if (options.json || !(dependencies.interactive ?? isInteractive())) {
			(dependencies.writeStdout ?? console.log)(
				JSON.stringify(
					{ schema_version: "clawdi.wallet.error.v1", status: "error", error: safe },
					null,
					2,
				),
			);
			process.exitCode = 1;
			return;
		}
		throw new Error(safe.message);
	}
}
