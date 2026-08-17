import type { SettleResponse } from "@x402/core/types";
import { type ClientEvmSigner, ExactEvmScheme } from "@x402/evm";
import {
	type PaymentPayload,
	type PaymentRequired,
	type PaymentRequirements,
	type SelectPaymentRequirements,
	x402Client,
	x402HTTPClient,
} from "@x402/fetch";
import { getAddress, isAddress } from "viem";

export const X402_BASE_NETWORK = "eip155:8453" as const;
export const X402_BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const USDC_DECIMALS = 6;
const MAX_AUTHORIZATION_SECONDS = 300;
const DEFAULT_PAID_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 402, 404, 410, 422]);
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type X402Fetch = (request: Request) => Promise<Response>;
export type X402RawFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createCredentiallessX402Fetch(
	fetchImplementation: X402RawFetch = globalThis.fetch,
	requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): X402Fetch {
	if (
		!Number.isSafeInteger(requestTimeoutMs) ||
		requestTimeoutMs < 1 ||
		requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
	) {
		throw new X402PaymentError(
			"invalid_request_timeout",
			"x402 request timeout must be between 1 and 60000 milliseconds.",
		);
	}
	return async (request) => {
		const headers = new Headers(request.headers);
		headers.delete("Authorization");
		headers.delete("Cookie");
		headers.delete("Proxy-Authorization");
		const controller = new AbortController();
		const timeout = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs);
		const abort = () => controller.abort();
		if (request.signal.aborted) controller.abort();
		else request.signal.addEventListener("abort", abort, { once: true });
		try {
			return await fetchImplementation(
				new Request(request, { credentials: "omit", headers, signal: controller.signal }),
				{ credentials: "omit", signal: controller.signal },
			);
		} finally {
			globalThis.clearTimeout(timeout);
			request.signal.removeEventListener("abort", abort);
		}
	};
}

export type X402TopupAuthority = Readonly<{
	amountAtomic: string;
	origin: string;
	payTo: string;
}>;

export type ValidatedX402TopupAuthority = Readonly<{
	authority: X402TopupAuthority;
	amountAtomic: bigint;
	amountUsd: string;
}>;

export type X402TopupOffer = {
	readonly authenticatedOrigin: string;
	readonly attemptId: string;
	readonly authority: X402TopupAuthority;
	readonly endpoint: string;
	readonly paymentRequired: PaymentRequired;
	readonly requirement: PaymentRequirements;
	readonly amountAtomic: bigint;
	readonly amountUsd: string;
};

export type X402TopupResult = {
	settlement: SettleResponse;
};

export class X402PaymentError extends Error {
	readonly code: string;
	readonly status?: number;

	constructor(code: string, message: string, status?: number) {
		super(message);
		this.name = "X402PaymentError";
		this.code = code;
		this.status = status;
	}
}

export function validateX402TopupAuthority(
	authority: X402TopupAuthority,
	authenticatedOrigin: string,
): ValidatedX402TopupAuthority {
	const normalized = normalizeTopupAuthority(authority);
	if (normalized.origin !== canonicalAuthenticatedOrigin(authenticatedOrigin)) {
		throw invalidPaymentAuthority();
	}
	const amountAtomic = BigInt(normalized.amountAtomic);
	return {
		authority: normalized,
		amountAtomic,
		amountUsd: formatUsdcAmount(amountAtomic),
	};
}

export async function loadX402TopupOffer(input: {
	authenticatedOrigin: string;
	attemptId: string;
	authority: X402TopupAuthority;
	maxAmountAtomic: bigint;
	fetch: X402Fetch;
}): Promise<X402TopupOffer> {
	const validatedAuthority = validateX402TopupAuthority(input.authority, input.authenticatedOrigin);
	const { authority } = validatedAuthority;
	const attemptId = canonicalAttemptId(input.attemptId);
	const endpoint = topupEndpoint(authority, attemptId);
	let response: Response;
	try {
		response = await input.fetch(
			new Request(endpoint, {
				credentials: "omit",
				method: "POST",
				headers: { Accept: "application/json" },
			}),
		);
	} catch {
		throw new X402PaymentError(
			"challenge_unavailable",
			"Could not request the x402 top-up offer. Check your connection and try again.",
		);
	}
	if (response.status !== 402) {
		throw new X402PaymentError(
			"challenge_unavailable",
			"The Hosted API did not return an x402 payment offer.",
			response.status,
		);
	}

	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		body = undefined;
	}

	let paymentRequired: PaymentRequired;
	try {
		const parser = new x402HTTPClient(new x402Client());
		paymentRequired = parser.getPaymentRequiredResponse((name) => response.headers.get(name), body);
	} catch {
		throw new X402PaymentError(
			"invalid_payment_offer",
			"The Hosted API returned an invalid x402 payment offer.",
		);
	}

	const requirement = validateOffer(
		paymentRequired,
		endpoint,
		authority.amountAtomic,
		authority.payTo,
		input.maxAmountAtomic,
	);
	const amountAtomic = BigInt(requirement.amount);
	return {
		authenticatedOrigin: input.authenticatedOrigin,
		attemptId,
		authority,
		endpoint,
		paymentRequired,
		requirement,
		amountAtomic,
		amountUsd: formatUsdcAmount(amountAtomic),
	};
}

export async function payX402Topup(input: {
	offer: X402TopupOffer;
	signer: ClientEvmSigner;
	fetch: X402Fetch;
	maxPaidAttempts?: number;
	sleep?: (delayMs: number) => Promise<void>;
}): Promise<X402TopupResult> {
	const maxPaidAttempts = input.maxPaidAttempts ?? DEFAULT_PAID_ATTEMPTS;
	if (!Number.isSafeInteger(maxPaidAttempts) || maxPaidAttempts < 1 || maxPaidAttempts > 5) {
		throw new X402PaymentError(
			"invalid_retry_policy",
			"x402 paid attempts must be between 1 and 5.",
		);
	}

	const authority = validateX402TopupAuthority(
		input.offer.authority,
		input.offer.authenticatedOrigin,
	).authority;
	const attemptId = canonicalAttemptId(input.offer.attemptId);
	const requirement = validateOffer(
		input.offer.paymentRequired,
		exactTopupEndpoint(input.offer.endpoint, authority, attemptId),
		authority.amountAtomic,
		authority.payTo,
		input.offer.amountAtomic,
	);
	if (!sameRequirement(requirement, input.offer.requirement)) {
		throw new X402PaymentError("invalid_payment_offer", "The x402 payment offer changed locally.");
	}

	const client = new x402Client(strictRequirementSelector(requirement))
		.register(X402_BASE_NETWORK, new ExactEvmScheme(input.signer))
		.registerPolicy((version, requirements) =>
			version === 2
				? requirements.filter((candidate) => sameRequirement(candidate, requirement))
				: [],
		);
	const http = new x402HTTPClient(client);
	let payload: PaymentPayload;
	let paymentHeaders: Record<string, string>;
	try {
		payload = await http.createPaymentPayload(input.offer.paymentRequired);
		paymentHeaders = http.encodePaymentSignatureHeader(payload);
	} catch {
		throw new X402PaymentError(
			"payment_signing_failed",
			"The local wallet could not sign the x402 authorization.",
		);
	}

	const paymentSignature = paymentHeaders["PAYMENT-SIGNATURE"];
	if (!paymentSignature) {
		throw new X402PaymentError(
			"payment_signing_failed",
			"The x402 client did not produce a payment authorization.",
		);
	}

	const sleep =
		input.sleep ??
		((delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)));
	let response: Response | undefined;
	for (let attempt = 1; attempt <= maxPaidAttempts; attempt += 1) {
		try {
			response = await input.fetch(
				new Request(input.offer.endpoint, {
					credentials: "omit",
					method: "POST",
					headers: {
						Accept: "application/json",
						"PAYMENT-SIGNATURE": paymentSignature,
					},
				}),
			);
		} catch {
			if (attempt === maxPaidAttempts) {
				throw paymentOutcomeUnknown();
			}
			await sleep(250 * attempt);
			continue;
		}

		if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxPaidAttempts) break;
		await sleep(retryDelayMs(response, attempt));
	}

	if (!response) {
		throw paymentOutcomeUnknown();
	}
	if (RETRYABLE_STATUSES.has(response.status)) {
		throw paymentOutcomeUnknown(response.status);
	}
	if (DEFINITIVE_REJECTION_STATUSES.has(response.status)) {
		throw new X402PaymentError(
			"payment_rejected",
			"The Hosted API rejected the x402 payment authorization.",
			response.status,
		);
	}
	if (!response.ok) throw paymentOutcomeUnknown(response.status);

	let settlement: SettleResponse | undefined;
	try {
		const result = await http.processPaymentResult(
			payload,
			(name) => response?.headers.get(name),
			response.status,
		);
		settlement = result.settleResponse;
	} catch {
		throw paymentOutcomeUnknown(response.status);
	}
	if (!settlement?.success) {
		throw paymentOutcomeUnknown(response.status);
	}
	if (
		settlement.network !== requirement.network ||
		settlement.amount !== requirement.amount ||
		settlement.payer?.toLowerCase() !== input.signer.address.toLowerCase() ||
		!/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)
	) {
		throw paymentOutcomeUnknown(response.status);
	}

	return { settlement };
}

function validateOffer(
	paymentRequired: PaymentRequired,
	endpoint: string,
	expectedAmountAtomic: string,
	expectedPayTo: string,
	maxAmountAtomic: bigint,
): PaymentRequirements {
	if (
		paymentRequired.x402Version !== 2 ||
		paymentRequired.resource.url !== endpoint ||
		paymentRequired.accepts.length !== 1
	) {
		throw new X402PaymentError(
			"unsupported_payment_offer",
			"The x402 offer does not match the requested top-up resource.",
		);
	}
	const requirement = paymentRequired.accepts[0];
	if (!requirement) {
		throw new X402PaymentError(
			"unsupported_payment_offer",
			"The x402 offer has no payment option.",
		);
	}
	const amountAtomic = canonicalAtomicAmount(requirement.amount);
	const extra = requirement.extra;
	const payTo = canonicalEvmAddress(requirement.payTo);
	if (
		requirement.scheme !== "exact" ||
		requirement.network !== X402_BASE_NETWORK ||
		requirement.asset.toLowerCase() !== X402_BASE_USDC.toLowerCase() ||
		payTo === null ||
		payTo !== expectedPayTo ||
		requirement.maxTimeoutSeconds < 1 ||
		requirement.maxTimeoutSeconds > MAX_AUTHORIZATION_SECONDS ||
		extra.name !== "USD Coin" ||
		extra.version !== "2" ||
		(extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") ||
		requirement.amount !== expectedAmountAtomic ||
		amountAtomic > maxAmountAtomic
	) {
		throw new X402PaymentError(
			"unsupported_payment_offer",
			"The x402 offer is not an exact Base USDC payment within the authorized limit.",
		);
	}
	return requirement;
}

function canonicalAtomicAmount(value: string): bigint {
	if (!/^[1-9][0-9]*$/.test(value)) {
		throw new X402PaymentError(
			"unsupported_payment_offer",
			"The x402 offer contains an invalid USDC amount.",
		);
	}
	return BigInt(value);
}

function sameRequirement(left: PaymentRequirements, right: PaymentRequirements): boolean {
	return (
		left.scheme === right.scheme &&
		left.network === right.network &&
		left.asset.toLowerCase() === right.asset.toLowerCase() &&
		left.amount === right.amount &&
		left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
		left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
		JSON.stringify(left.extra) === JSON.stringify(right.extra)
	);
}

function strictRequirementSelector(expected: PaymentRequirements): SelectPaymentRequirements {
	return (version, requirements) => {
		const selected = requirements[0];
		if (
			version !== 2 ||
			requirements.length !== 1 ||
			!selected ||
			!sameRequirement(selected, expected)
		) {
			throw new X402PaymentError(
				"unsupported_payment_offer",
				"The x402 client could not select the exact validated Base USDC offer.",
			);
		}
		return selected;
	};
}

function normalizeTopupAuthority(authority: X402TopupAuthority): X402TopupAuthority {
	let url: URL;
	try {
		url = new URL(authority.origin);
	} catch {
		throw new X402PaymentError(
			"invalid_payment_authority",
			"The authenticated x402 payment authority is invalid.",
		);
	}
	const secure =
		url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
	const payTo = canonicalEvmAddress(authority.payTo);
	let amountAtomic: string;
	try {
		amountAtomic = canonicalAtomicAmount(authority.amountAtomic).toString();
	} catch {
		throw invalidPaymentAuthority();
	}
	if (
		!secure ||
		authority.origin !== url.origin ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		payTo === null ||
		payTo === "0x0000000000000000000000000000000000000000"
	) {
		throw invalidPaymentAuthority();
	}
	return { amountAtomic, origin: url.origin, payTo };
}

function exactTopupEndpoint(
	value: string,
	authority: X402TopupAuthority,
	attemptId: string,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new X402PaymentError("invalid_endpoint", "The Hosted x402 endpoint is invalid.");
	}
	const expected = topupEndpoint(authority, attemptId);
	if (
		url.origin !== authority.origin ||
		url.toString() !== expected ||
		url.pathname !== "/v2/x402/topup" ||
		url.hash ||
		url.username ||
		url.password
	) {
		throw new X402PaymentError("invalid_endpoint", "The Hosted x402 endpoint is invalid.");
	}
	return expected;
}

function canonicalAttemptId(value: string): string {
	if (!ATTEMPT_ID.test(value)) {
		throw new X402PaymentError("invalid_attempt", "The Hosted x402 attempt is invalid.");
	}
	return value.toLowerCase();
}

function topupEndpoint(authority: X402TopupAuthority, attemptId: string): string {
	return `${authority.origin}/v2/x402/topup?attempt_id=${attemptId}`;
}

function canonicalEvmAddress(value: string): string | null {
	if (!isAddress(value)) return null;
	return getAddress(value);
}

function canonicalAuthenticatedOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidPaymentAuthority();
	}
	if (
		url.origin !== value ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
	) {
		throw invalidPaymentAuthority();
	}
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function paymentOutcomeUnknown(status?: number): X402PaymentError {
	return new X402PaymentError(
		"payment_outcome_unknown",
		"The paid x402 request could not be verified. Funds or Wallet credit may already have moved. Do not create a new payment; check the authenticated Wallet balance and transaction status first.",
		status,
	);
}

function invalidPaymentAuthority(): X402PaymentError {
	return new X402PaymentError(
		"invalid_payment_authority",
		"The authenticated x402 payment authority is invalid.",
	);
}

function formatUsdcAmount(amountAtomic: bigint): string {
	const unit = 10n ** BigInt(USDC_DECIMALS);
	const whole = amountAtomic / unit;
	const fraction = (amountAtomic % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

function retryDelayMs(response: Response, attempt: number): number {
	const retryAfter = response.headers.get("Retry-After");
	if (retryAfter && /^[0-9]+$/.test(retryAfter)) {
		return Math.min(Number(retryAfter) * 1_000, MAX_RETRY_DELAY_MS);
	}
	return Math.min(attempt * 250, MAX_RETRY_DELAY_MS);
}
