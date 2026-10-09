import type { HostedDeployWallet, HostedWalletBinding } from "@clawdi/shared/api";
import { parsePositiveInteger } from "../lib/cli-options";
import { emit } from "../lib/command-output";
import { isAuthorizationRequired, mapHttpError } from "../lib/errors";
import { HostedDeployAuthorizationError } from "../lib/hosted-deploy-auth";
import { HostedDeployApiError, HostedDeployClient } from "../lib/hosted-deploy-client";
import { AuthorizationRequiredError, requireAuth } from "../lib/require-auth";

export async function walletTransactionsCommand(
	options: { limit?: string | number; json?: boolean } = {},
): Promise<void> {
	requireAuth();
	const limit = options.limit === undefined ? undefined : parsePositiveInteger(options.limit);
	const result = await readWalletResult(() =>
		new HostedDeployClient().getWalletTransactions(limit),
	);
	if (options.json) {
		emit({
			schemaVersion: "clawdi.walletTransactions.v2",
			transactions: result.items.map((item) => ({
				id: item.id,
				occurredAt: item.occurred_at,
				direction: item.direction,
				amount: item.amount,
				kind: item.kind,
				status: item.status,
			})),
			hasMore: result.has_more,
		});
		return;
	}
	if (result.items.length === 0) console.log("No wallet transactions.");
	for (const item of result.items) {
		console.log(
			`${item.id}  ${item.occurred_at}  ${item.direction} $${item.amount}  ${item.kind}  ${item.status}`,
		);
	}
	if (result.has_more)
		console.error("More transactions are available. Increase --limit to show more.");
}

export async function walletUsageCommand(
	options: { days?: string | number; json?: boolean } = {},
): Promise<void> {
	requireAuth();
	const days = options.days === undefined ? undefined : parsePositiveInteger(options.days);
	const result = await readWalletResult(() => new HostedDeployClient().getWalletUsage(days));
	if (options.json) {
		emit({
			schemaVersion: "clawdi.walletUsage.v2",
			periodStart: result.period_start,
			periodEnd: result.period_end,
			totalUsd: result.total_usd,
			totalRequests: result.total_requests,
			availability: result.availability,
			byDay: result.by_day.map((item) => ({ date: item.date, amountUsd: item.amount_usd })),
		});
		return;
	}
	console.log(`Period: ${result.period_start} – ${result.period_end}`);
	console.log(
		`Usage: ${result.total_usd === null ? "unavailable" : `$${result.total_usd}`} (${result.total_requests ?? "unavailable"} requests)`,
	);
	console.log(`Availability: ${result.availability}`);
	for (const item of result.by_day) console.log(`${item.date}  $${item.amount_usd}`);
}

export async function walletPortalCommand(): Promise<void> {
	requireAuth();
	console.log("https://cloud.clawdi.ai/?settings=billing-wallet");
}

async function readWalletResult<T>(load: () => Promise<T>): Promise<T> {
	try {
		return await load();
	} catch (error) {
		const safe = safeWalletStatusError(error);
		if (isAuthorizationRequired(error)) {
			throw new AuthorizationRequiredError(safe.message);
		}
		throw new Error(safe.message);
	}
}

export type WalletStatusOptions = { json?: boolean };

export interface WalletStatusGateway {
	getWallet(): Promise<HostedDeployWallet>;
	getWalletBinding(): Promise<HostedWalletBinding>;
}

export type WalletStatusDependencies = {
	client?: WalletStatusGateway;
	interactive?: boolean;
	writeStdout?: (value: string) => void;
	writeStderr?: (value: string) => void;
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
		"Clawdi returned an invalid wallet response.",
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
		schemaVersion: "clawdi.walletStatus.v2",
		balanceUsd: wallet.balance_usd,
		x402Enabled: wallet.x402_enabled,
		x402PaymentStatus: wallet.x402_payment_status,
		x402PaymentAttempt: wallet.x402_payment_attempt ?? null,
		x402PaymentAuthority: wallet.x402_payment_authority,
		binding: {
			bound: binding.bound,
			address,
			verifiedAt: binding.verified_at ?? null,
		},
	};
	const writeStdout = dependencies.writeStdout ?? console.log;
	if (options.json) {
		emit(result, true, writeStdout);
	} else {
		writeStdout(
			[
				`Wallet balance: $${wallet.balance_usd}`,
				`USDC funding: ${fundingStatus}`,
				`Verified wallet: ${address ?? "not bound"}`,
			].join("\n"),
		);
	}
}

function safeWalletStatusError(error: unknown): { code: string; message: string } {
	if (error instanceof WalletStatusError) return { code: error.code, message: error.message };
	if (
		error instanceof HostedDeployAuthorizationError &&
		error.code === "hosted_oauth_login_required"
	) {
		return { code: "not_signed_in", message: "Not signed in. Run `clawdi auth login` first." };
	}
	if (error instanceof HostedDeployAuthorizationError) {
		const mapped = mapHttpError({ status: 0, code: error.code }, "Hosted Wallet");
		if (mapped) return { code: mapped.code, message: mapped.message };
	}
	if (error instanceof HostedDeployApiError) {
		const mapped = mapHttpError(error, "Hosted Wallet");
		if (mapped) return { code: mapped.code, message: mapped.message };
		return {
			code:
				error.status >= 500 || error.status === 0 ? "hosted_unavailable" : "hosted_wallet_error",
			message:
				error.status >= 500 || error.status === 0
					? "Wallet is temporarily unavailable."
					: "Clawdi rejected the wallet request.",
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
		const authorizationRequired = isAuthorizationRequired(error);
		if (options.json) {
			emit(
				{ schemaVersion: "clawdi.walletStatus.v2", status: "error", error: safe },
				true,
				dependencies.writeStderr ?? console.error,
			);
			process.exitCode = authorizationRequired ? 4 : 1;
			return;
		}
		if (authorizationRequired) throw new AuthorizationRequiredError(safe.message);
		throw new Error(safe.message);
	}
}
