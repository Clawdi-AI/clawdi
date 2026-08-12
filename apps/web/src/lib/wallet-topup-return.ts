export const WALLET_TOPUP_RETURN_PARAM = "topup_return";
export const STRIPE_PAYMENT_INTENT_PARAM = "payment_intent";
export const STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM = "payment_intent_client_secret";
export const STRIPE_REDIRECT_STATUS_PARAM = "redirect_status";

export interface WalletTopupReturnState {
	clientSecret: string;
}

export interface WalletTopupReturnResolution {
	status: string | null;
	paymentIntentId: string | null;
	errorMessage: string | null;
}

let pendingReturn: WalletTopupReturnState | null = null;
let resolution: Promise<WalletTopupReturnResolution> | null = null;

export function readWalletTopupReturn(search: string): WalletTopupReturnState | null {
	const params = new URLSearchParams(search);
	if (params.get(WALLET_TOPUP_RETURN_PARAM) !== "1") return null;
	const clientSecret = params.get(STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM);
	if (!clientSecret?.trim()) return null;
	return { clientSecret };
}

export function cleanWalletTopupReturnUrl(currentHref: string): string {
	const url = new URL(currentHref);
	url.searchParams.delete(WALLET_TOPUP_RETURN_PARAM);
	url.searchParams.delete(STRIPE_PAYMENT_INTENT_PARAM);
	url.searchParams.delete(STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM);
	url.searchParams.delete(STRIPE_REDIRECT_STATUS_PARAM);
	return url.toString();
}

export function consumeWalletTopupReturn(
	currentHref: string,
	historyState: unknown,
	replaceState: (state: unknown, unused: string, url: string) => void,
): WalletTopupReturnState | null {
	const url = new URL(currentHref);
	if (!url.searchParams.has(WALLET_TOPUP_RETURN_PARAM)) return null;
	const result = readWalletTopupReturn(url.search);
	replaceState(historyState, "", cleanWalletTopupReturnUrl(currentHref));
	return result;
}

export function bootstrapWalletTopupReturn(
	currentHref: string,
	historyState: unknown,
	replaceState: (state: unknown, unused: string, url: string) => void,
): void {
	pendingReturn = consumeWalletTopupReturn(currentHref, historyState, replaceState);
}

export function coordinateWalletTopupReturn(
	retrieve: (clientSecret: string) => Promise<WalletTopupReturnResolution>,
): Promise<WalletTopupReturnResolution> | null {
	if (resolution) return resolution;
	if (!pendingReturn) return null;
	const { clientSecret } = pendingReturn;
	pendingReturn = null;
	resolution = retrieve(clientSecret);
	return resolution;
}

export function cleanMarkedWalletTopupReturnRequest(request: Request): Request {
	const url = new URL(request.url);
	if (!url.searchParams.has(WALLET_TOPUP_RETURN_PARAM)) return request;
	return new Request(cleanWalletTopupReturnUrl(request.url), request);
}
