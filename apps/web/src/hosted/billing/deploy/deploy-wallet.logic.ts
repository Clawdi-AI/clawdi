import type {
	HostedDeployRequestStatus,
	WalletComputeActivateResult,
} from "@/hosted/billing/contracts";
import {
	BillingApiError,
	isNetworkError,
	isRetryableError,
	walletComputeErrorDetail,
} from "@/hosted/billing/errors";
import { decimalCredits } from "@/hosted/billing/wallet/wallet-compute.logic";

export type DeployPaymentMethod = "card" | "wallet";

export type WalletActivationFailure = {
	kind: "insufficient" | "conflict" | "retryable" | "other";
	code: string | null;
	shortfallCredits: number | null;
	description: string;
};

export function walletActivationFailure(error: unknown): WalletActivationFailure {
	const detail = walletComputeErrorDetail(error);
	const code = typeof detail === "string" ? null : (detail?.code ?? null);
	if (error instanceof BillingApiError && error.status === 402) {
		const shortfall =
			detail && typeof detail !== "string" && "shortfall_credits" in detail
				? detail.shortfall_credits
				: null;
		return {
			kind: "insufficient",
			code,
			shortfallCredits: shortfall === null ? null : decimalCredits(shortfall),
			description: "Your wallet does not have enough credits for the first compute charge.",
		};
	}
	if (error instanceof BillingApiError && error.status === 409) {
		return {
			kind: "conflict",
			code,
			shortfallCredits: null,
			description:
				code === "open_refund_debt"
					? "A wallet refund is still settling. Wait for it to finish before funding compute."
					: "Another billing action owns this deploy request. Refresh the quote before trying again.",
		};
	}
	const retryablePayload = detail !== null && typeof detail !== "string" && "retryable" in detail;
	if (
		isNetworkError(error) ||
		(error instanceof BillingApiError && error.status >= 500 && retryablePayload)
	) {
		return {
			kind: "retryable",
			code,
			shortfallCredits: null,
			description:
				"The wallet charge result is temporarily unclear. Retry with the same deploy request; you will not be charged twice.",
		};
	}
	return {
		kind: "other",
		code,
		shortfallCredits: null,
		description: "Wallet funding could not be completed. Check the details and try again.",
	};
}

export function walletPaymentDisabledReason(billingTermMonths: number): string | null {
	return billingTermMonths === 1
		? null
		: "Wallet-funded compute renews monthly. Choose Monthly or use a card for Annual billing.";
}

type DeployRequestLookup = (deployRequestId: string) => Promise<HostedDeployRequestStatus>;

type DeploymentResolutionOptions = {
	maxAttempts?: number;
	delay?: (milliseconds: number) => Promise<void>;
};

const TERMINAL_DEPLOY_REQUEST_STATUSES = new Set<HostedDeployRequestStatus["request_status"]>([
	"failed",
	"expired",
	"superseded",
]);

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

/** Resolve the autodeployed row without guessing from list ordering. */
export async function resolveWalletDeploymentId(
	activation: WalletComputeActivateResult,
	lookup: DeployRequestLookup,
	options: DeploymentResolutionOptions = {},
): Promise<string | null> {
	if (activation.deployment_id) return activation.deployment_id;
	const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
	const delay = options.delay ?? wait;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			const status = await lookup(activation.deploy_request_id);
			if (status.deploy_request_id !== activation.deploy_request_id) {
				throw new Error("Deployment request lookup returned a mismatched request ID.");
			}
			if (status.deployment_id) return status.deployment_id;
			if (TERMINAL_DEPLOY_REQUEST_STATUSES.has(status.request_status)) return null;
		} catch (error) {
			const requestNotProjected = error instanceof BillingApiError && error.status === 404;
			if (!requestNotProjected && !isRetryableError(error)) throw error;
		}

		if (attempt < maxAttempts - 1) {
			await delay(Math.min(1_000 + attempt * 500, 2_500));
		}
	}

	return null;
}
