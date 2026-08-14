export const WALLET_PAYMENT_RETURN_PARAM = "wallet_payment_return";
export const WALLET_PAYMENT_FLOW_PARAM = "wallet_payment_flow";
export const WALLET_SETUP_RETURN_PARAM = "wallet_setup_return";
export const WALLET_SETUP_IDENTITY_PARAM = "wallet_setup_id";
export const STRIPE_PAYMENT_INTENT_PARAM = "payment_intent";
export const STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM = "payment_intent_client_secret";
export const STRIPE_SETUP_INTENT_PARAM = "setup_intent";
export const STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM = "setup_intent_client_secret";
export const STRIPE_REDIRECT_STATUS_PARAM = "redirect_status";

const WALLET_STRIPE_RETURN_PARAMS = [
	WALLET_PAYMENT_RETURN_PARAM,
	WALLET_PAYMENT_FLOW_PARAM,
	"topup_return",
	WALLET_SETUP_RETURN_PARAM,
	WALLET_SETUP_IDENTITY_PARAM,
	STRIPE_PAYMENT_INTENT_PARAM,
	STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM,
	STRIPE_SETUP_INTENT_PARAM,
	STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM,
	STRIPE_REDIRECT_STATUS_PARAM,
] as const;

const WALLET_STRIPE_RETURN_OWNER_PARAMS = [
	WALLET_PAYMENT_RETURN_PARAM,
	WALLET_PAYMENT_FLOW_PARAM,
	"topup_return",
	WALLET_SETUP_RETURN_PARAM,
	WALLET_SETUP_IDENTITY_PARAM,
] as const;

const STRIPE_RETURN_PARAMS = [
	STRIPE_PAYMENT_INTENT_PARAM,
	STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM,
	STRIPE_SETUP_INTENT_PARAM,
	STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM,
	STRIPE_REDIRECT_STATUS_PARAM,
] as const;

type WalletStripeReturnKind = "payment_intent" | "setup_intent";
export type WalletPaymentReturnFlow = "manual_topup" | "auto_reload";

export type WalletStripeReturnState =
	| {
			kind: "payment_intent";
			clientSecret: string;
			expectedIntentId: string;
			flow: WalletPaymentReturnFlow;
	  }
	| {
			kind: "setup_intent";
			clientSecret: string;
			expectedIntentId: string;
			setupIdentity: string;
	  };

export interface WalletPaymentReturnResolution {
	flow: WalletPaymentReturnFlow;
	status: string | null;
	paymentIntentId: string | null;
	errorMessage: string | null;
}

export interface WalletSetupReturnResolution {
	status: string | null;
	setupIntentId: string | null;
	setupIdentity: string;
	errorMessage: string | null;
}

export type WalletSetupReturnFinalizer = (confirmed: {
	setupIdentity: string;
	setupIntentId: string;
}) => Promise<string | null>;

const SETUP_INTENT_MISMATCH_ERROR =
	"The returned card setup could not be verified. Start a new card authorization.";
const PAYMENT_INTENT_MISMATCH_ERROR =
	"The returned payment could not be verified. Open Wallet and check your balance before trying again.";
const ROOT_RELATIVE_URL_BASE = "https://wallet-return.invalid";

type ResolutionSlot<TResult> = {
	fingerprint: string;
	promise: Promise<TResult>;
};

function resolutionSlot<TResult>(
	fingerprint: string,
	promise: Promise<TResult>,
	clearIfCurrent: (slot: ResolutionSlot<TResult>) => void,
): ResolutionSlot<TResult> {
	const slot = { fingerprint, promise };
	const settle = () => clearIfCurrent(slot);
	void promise.then(settle, settle);
	return slot;
}

const pendingReturns = new Map<WalletStripeReturnKind, WalletStripeReturnState>();
let paymentResolution: ResolutionSlot<WalletPaymentReturnResolution> | null = null;
let setupResolution: ResolutionSlot<WalletSetupReturnResolution> | null = null;

function canonicalParam(params: URLSearchParams, key: string): string | null {
	const values = params.getAll(key);
	if (values.length !== 1) return null;
	const value = values[0];
	return value && value === value.trim() ? value : null;
}

function stripeIntentId(value: string | null, prefix: "pi_" | "seti_"): string | null {
	if (value === null || value.length > 255 || value !== value.trim()) {
		return null;
	}
	const suffix = value.slice(prefix.length);
	return value.startsWith(prefix) && suffix ? value : null;
}

function stripeClientSecret(
	value: string | null,
	prefix: "pi_" | "seti_",
): { value: string; intentId: string } | null {
	if (!value || value.length > 1024 || value !== value.trim()) return null;
	const separator = "_secret_";
	const separatorIndex = value.indexOf(separator);
	if (separatorIndex <= 0) return null;
	const intentId = value.slice(0, separatorIndex);
	const secret = value.slice(separatorIndex + separator.length);
	return secret && stripeIntentId(intentId, prefix) === intentId ? { value, intentId } : null;
}

export function walletSetupIntentMatchesClientSecret(
	clientSecret: string,
	setupIntentId: string,
): boolean {
	const parsedSecret = stripeClientSecret(clientSecret, "seti_");
	return (
		parsedSecret !== null &&
		stripeIntentId(setupIntentId, "seti_") === setupIntentId &&
		parsedSecret.intentId === setupIntentId
	);
}

function setupIdentity(value: string | null): string | null {
	return value && walletSetupIdentityIsCanonical(value) ? value : null;
}

export function walletSetupIdentityIsCanonical(value: string): boolean {
	return /^wsetup_[a-f0-9]{64}$/.test(value);
}

function returnFingerprint(state: WalletStripeReturnState): string {
	return state.kind === "setup_intent"
		? `${state.clientSecret}\0${state.setupIdentity}`
		: `${state.clientSecret}\0${state.flow}`;
}

function walletPaymentFlow(value: string | null): WalletPaymentReturnFlow | null {
	return value === "manual_topup" || value === "auto_reload" ? value : null;
}

function hasWalletStripeReturnParam(params: URLSearchParams): boolean {
	if (WALLET_STRIPE_RETURN_OWNER_PARAMS.some((key) => params.has(key))) return true;
	return (
		params.getAll("settings").includes("billing-wallet") &&
		STRIPE_RETURN_PARAMS.some((key) => params.has(key))
	);
}

function hasExactWalletStripeReturnCardinality(params: URLSearchParams): boolean {
	return WALLET_STRIPE_RETURN_PARAMS.every((key) => params.getAll(key).length <= 1);
}

function walletStripeUrl(value: string): { url: URL; rootRelative: boolean } {
	const rootRelative = value.startsWith("/") && !value.startsWith("//");
	return {
		url: rootRelative ? new URL(value, ROOT_RELATIVE_URL_BASE) : new URL(value),
		rootRelative,
	};
}

function walletStripeUrlString(url: URL, rootRelative: boolean): string {
	return rootRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

export function readWalletStripeReturn(search: string): WalletStripeReturnState | null {
	const params = new URLSearchParams(search);
	if (!hasExactWalletStripeReturnCardinality(params)) return null;
	if (params.has("topup_return")) return null;
	if (params.has(WALLET_SETUP_RETURN_PARAM) && params.has(WALLET_PAYMENT_RETURN_PARAM)) return null;
	const setupMarked = canonicalParam(params, WALLET_SETUP_RETURN_PARAM) === "1";
	const paymentMarked = canonicalParam(params, WALLET_PAYMENT_RETURN_PARAM) === "1";
	if (setupMarked === paymentMarked) return null;
	const hasPaymentIdentity =
		params.has(WALLET_PAYMENT_FLOW_PARAM) ||
		params.has(STRIPE_PAYMENT_INTENT_PARAM) ||
		params.has(STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM);
	const hasSetupIdentity =
		params.has(WALLET_SETUP_IDENTITY_PARAM) ||
		params.has(STRIPE_SETUP_INTENT_PARAM) ||
		params.has(STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM);
	if ((setupMarked && hasPaymentIdentity) || (paymentMarked && hasSetupIdentity)) return null;

	if (setupMarked) {
		const clientSecret = stripeClientSecret(
			canonicalParam(params, STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM),
			"seti_",
		);
		const intentId = stripeIntentId(canonicalParam(params, STRIPE_SETUP_INTENT_PARAM), "seti_");
		const identity = setupIdentity(canonicalParam(params, WALLET_SETUP_IDENTITY_PARAM));
		if (!clientSecret || intentId !== clientSecret.intentId || !identity) {
			return null;
		}
		return {
			kind: "setup_intent",
			clientSecret: clientSecret.value,
			expectedIntentId: clientSecret.intentId,
			setupIdentity: identity,
		};
	}

	const clientSecret = stripeClientSecret(
		canonicalParam(params, STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM),
		"pi_",
	);
	const intentId = stripeIntentId(canonicalParam(params, STRIPE_PAYMENT_INTENT_PARAM), "pi_");
	const flow = walletPaymentFlow(canonicalParam(params, WALLET_PAYMENT_FLOW_PARAM));
	if (!clientSecret || intentId !== clientSecret.intentId || !flow) {
		return null;
	}
	return {
		kind: "payment_intent",
		clientSecret: clientSecret.value,
		expectedIntentId: clientSecret.intentId,
		flow,
	};
}

export function buildWalletStripeReturnUrl(
	currentHref: string,
	params: readonly (readonly [string, string])[] = [],
): string {
	const { url, rootRelative } = walletStripeUrl(currentHref);
	for (const key of WALLET_STRIPE_RETURN_PARAMS) {
		url.searchParams.delete(key);
	}
	for (const [key, value] of params) {
		url.searchParams.set(key, value);
	}
	return walletStripeUrlString(url, rootRelative);
}

export function cleanWalletStripeReturnUrl(currentHref: string): string {
	return buildWalletStripeReturnUrl(currentHref);
}

export function consumeWalletStripeReturn(
	currentHref: string,
	historyState: unknown,
	replaceState: (state: unknown, unused: string, url: string) => void,
): WalletStripeReturnState | null {
	const { url } = walletStripeUrl(currentHref);
	if (!hasWalletStripeReturnParam(url.searchParams)) return null;
	const result = readWalletStripeReturn(url.search);
	replaceState(historyState, "", cleanWalletStripeReturnUrl(currentHref));
	return result;
}

export function bootstrapWalletStripeReturn(
	currentHref: string,
	historyState: unknown,
	replaceState: (state: unknown, unused: string, url: string) => void,
): void {
	const { url } = walletStripeUrl(currentHref);
	const hasReturnParam = hasWalletStripeReturnParam(url.searchParams);
	const result = consumeWalletStripeReturn(currentHref, historyState, replaceState);
	if (result) {
		pendingReturns.clear();
		if (result.kind === "payment_intent") {
			setupResolution = null;
		} else {
			paymentResolution = null;
		}
		pendingReturns.set(result.kind, result);
		return;
	}
	if (hasReturnParam) {
		pendingReturns.clear();
		paymentResolution = null;
		setupResolution = null;
	}
}

function takePendingReturn(kind: WalletStripeReturnKind): WalletStripeReturnState | null {
	const pending = pendingReturns.get(kind);
	if (!pending) return null;
	pendingReturns.delete(kind);
	return pending;
}

export function coordinateWalletPaymentReturn(
	retrieve: (
		state: Extract<WalletStripeReturnState, { kind: "payment_intent" }>,
	) => Promise<Omit<WalletPaymentReturnResolution, "flow">>,
): Promise<WalletPaymentReturnResolution> | null {
	const pending = takePendingReturn("payment_intent");
	if (!pending) return paymentResolution?.promise ?? null;
	if (pending.kind !== "payment_intent") return null;
	const fingerprint = returnFingerprint(pending);
	if (paymentResolution?.fingerprint === fingerprint) {
		return paymentResolution.promise;
	}
	const promise = retrieve(pending).then((result) =>
		result.paymentIntentId === pending.expectedIntentId
			? { ...result, flow: pending.flow }
			: {
					...result,
					flow: pending.flow,
					status: null,
					paymentIntentId: null,
					errorMessage: PAYMENT_INTENT_MISMATCH_ERROR,
				},
	);
	paymentResolution = resolutionSlot(fingerprint, promise, (slot) => {
		if (paymentResolution === slot) paymentResolution = null;
	});
	return paymentResolution.promise;
}

export function coordinateWalletSetupReturn(
	retrieve: (
		state: Extract<WalletStripeReturnState, { kind: "setup_intent" }>,
	) => Promise<WalletSetupReturnResolution>,
	finalize?: WalletSetupReturnFinalizer,
): Promise<WalletSetupReturnResolution> | null {
	const pending = takePendingReturn("setup_intent");
	if (!pending) return setupResolution?.promise ?? null;
	if (pending.kind !== "setup_intent") return null;
	const fingerprint = returnFingerprint(pending);
	if (setupResolution?.fingerprint === fingerprint) {
		return setupResolution.promise;
	}
	const promise = retrieve(pending).then(async (result) => {
		if (
			result.setupIntentId !== pending.expectedIntentId ||
			result.setupIdentity !== pending.setupIdentity
		) {
			return {
				...result,
				status: null,
				setupIntentId: null,
				setupIdentity: pending.setupIdentity,
				errorMessage: SETUP_INTENT_MISMATCH_ERROR,
			};
		}
		if (
			finalize &&
			result.status === "succeeded" &&
			result.setupIntentId !== null &&
			result.errorMessage === null
		) {
			const errorMessage = await finalize({
				setupIdentity: result.setupIdentity,
				setupIntentId: result.setupIntentId,
			});
			return errorMessage ? { ...result, errorMessage } : result;
		}
		return result;
	});
	setupResolution = resolutionSlot(fingerprint, promise, (slot) => {
		if (setupResolution === slot) setupResolution = null;
	});
	return setupResolution.promise;
}

export function cleanWalletStripeReturnRequest(request: Request): Request {
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
