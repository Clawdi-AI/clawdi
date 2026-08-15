export const WALLET_STRIPE_RETURN_SECURITY_PARAMS = {
	walletPaymentReturn: "wallet_payment_return",
	walletPaymentFlow: "wallet_payment_flow",
	legacyTopupReturn: "topup_return",
	walletSetupReturn: "wallet_setup_return",
	walletSetupIdentity: "wallet_setup_id",
	stripePaymentIntent: "payment_intent",
	stripePaymentIntentClientSecret: "payment_intent_client_secret",
	stripeSetupIntent: "setup_intent",
	stripeSetupIntentClientSecret: "setup_intent_client_secret",
	stripeRedirectStatus: "redirect_status",
} as const;

const ALL_RETURN_PARAMS = Object.values(WALLET_STRIPE_RETURN_SECURITY_PARAMS);
const OWNER_PARAMS = [
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.walletPaymentReturn,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.walletPaymentFlow,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.legacyTopupReturn,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.walletSetupReturn,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.walletSetupIdentity,
] as const;
const STRIPE_PARAMS = [
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.stripePaymentIntent,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.stripePaymentIntentClientSecret,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.stripeSetupIntent,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.stripeSetupIntentClientSecret,
	WALLET_STRIPE_RETURN_SECURITY_PARAMS.stripeRedirectStatus,
] as const;
const ROOT_RELATIVE_URL_BASE = "https://wallet-return.invalid";

export function hasWalletStripeReturnParam(params: URLSearchParams): boolean {
	if (OWNER_PARAMS.some((key) => params.has(key))) return true;
	return (
		params.getAll("settings").includes("billing-wallet") &&
		STRIPE_PARAMS.some((key) => params.has(key))
	);
}

export function hasWalletStripeReturnUrl(currentHref: string): boolean {
	return hasWalletStripeReturnParam(walletStripeReturnUrl(currentHref).url.searchParams);
}

export function walletStripeReturnUrl(value: string): { url: URL; rootRelative: boolean } {
	const rootRelative = value.startsWith("/") && !value.startsWith("//");
	return {
		url: rootRelative ? new URL(value, ROOT_RELATIVE_URL_BASE) : new URL(value),
		rootRelative,
	};
}

export function walletStripeReturnUrlString(url: URL, rootRelative: boolean): string {
	return rootRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

export function cleanWalletStripeReturnUrl(currentHref: string): string {
	const { url, rootRelative } = walletStripeReturnUrl(currentHref);
	for (const key of ALL_RETURN_PARAMS) url.searchParams.delete(key);
	return walletStripeReturnUrlString(url, rootRelative);
}

export function scrubWalletStripeReturnLocation(
	currentHref: string,
	historyState: unknown,
	replaceState: (state: unknown, unused: string, url: string) => void,
): void {
	const { url } = walletStripeReturnUrl(currentHref);
	if (!hasWalletStripeReturnParam(url.searchParams)) return;
	replaceState(historyState, "", cleanWalletStripeReturnUrl(currentHref));
}

function cleanWalletStripeReturnRequest(request: Request): Request {
	const url = new URL(request.url);
	if (!hasWalletStripeReturnParam(url.searchParams)) return request;
	return new Request(cleanWalletStripeReturnUrl(request.url), request);
}

function secureWalletStripeReturnResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

export function fetchWithWalletStripeReturnPolicy(
	request: Request,
	fetchRequest: (request: Request) => Response | Promise<Response>,
): Response | Promise<Response> {
	const url = new URL(request.url);
	if (!hasWalletStripeReturnParam(url.searchParams)) return fetchRequest(request);
	const response = fetchRequest(cleanWalletStripeReturnRequest(request));
	return response instanceof Response
		? secureWalletStripeReturnResponse(response)
		: response.then(secureWalletStripeReturnResponse);
}
