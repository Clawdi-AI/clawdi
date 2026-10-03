/**
 * Store purchase boundary for native billing.
 *
 * This module deliberately has no RevenueCat or React Native purchase import.
 * The SDK is injected only after the app has a reviewed public-key config and
 * a Hosted entitlement-sync contract. Until then every action is explicit and
 * side-effect free (`disabled` or `unsupported`).
 */

export type PurchasePlatform = "ios" | "android" | "web" | "unknown";

export type PurchaseDisabledReason =
	| "account_required"
	| "hosted_sync_unavailable"
	| "missing_api_key"
	| "missing_product_id"
	| "sdk_unavailable";

export type PurchaseUnsupportedReason = "platform_not_supported";

export type PurchaseAvailability =
	| {
			state: "disabled";
			reason: PurchaseDisabledReason;
	  }
	| {
			state: "unsupported";
			reason: PurchaseUnsupportedReason;
			platform: PurchasePlatform;
	  }
	| {
			state: "ready";
			provider: "revenuecat";
			productId: string;
	  };

export type PurchaseActionResult =
	| { state: "disabled"; reason: PurchaseDisabledReason }
	| { state: "unsupported"; reason: PurchaseUnsupportedReason; platform: PurchasePlatform }
	| { state: "completed" }
	| { state: "failed"; reason: "provider_error" };

export type RevenueCatPurchaseClient = Readonly<{
	configure: (input: { apiKey: string; appUserId: string }) => Promise<void> | void;
	purchaseProduct: (productId: string) => Promise<void>;
	restorePurchases: () => Promise<void>;
}>;

type RevenueCatAvailabilityInput = Readonly<{
	platform: PurchasePlatform;
	apiKey: unknown;
	productId: unknown;
	/** True only after Hosted exposes an authenticated entitlement-sync contract. */
	hostedSyncAvailable: boolean;
	/** True when the native RevenueCat adapter is linked into the app binary. */
	sdkAvailable: boolean;
}>;

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result.length > 0 ? result : undefined;
}

function validPublicApiKey(value: unknown, platform: "ios" | "android"): value is string {
	const key = nonEmptyString(value);
	const prefix = platform === "ios" ? "appl_" : "goog_";
	return Boolean(key?.startsWith(prefix) && !/[\r\n]/.test(key));
}

function validProductId(value: unknown): value is string {
	const productId = nonEmptyString(value);
	return Boolean(productId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(productId));
}

export function resolveRevenueCatPurchaseAvailability(
	input: RevenueCatAvailabilityInput,
): PurchaseAvailability {
	if (input.platform !== "ios" && input.platform !== "android") {
		return {
			state: "unsupported",
			reason: "platform_not_supported",
			platform: input.platform,
		};
	}
	if (!validPublicApiKey(input.apiKey, input.platform))
		return { state: "disabled", reason: "missing_api_key" };
	if (!validProductId(input.productId)) return { state: "disabled", reason: "missing_product_id" };
	if (!input.sdkAvailable) return { state: "disabled", reason: "sdk_unavailable" };
	if (!input.hostedSyncAvailable) return { state: "disabled", reason: "hosted_sync_unavailable" };
	return { state: "ready", provider: "revenuecat", productId: input.productId.trim() };
}

export type RevenueCatPurchaseBoundary = Readonly<{
	availability: PurchaseAvailability;
	purchase: () => Promise<PurchaseActionResult>;
	restore: () => Promise<PurchaseActionResult>;
}>;

type RevenueCatPurchaseBoundaryOptions = RevenueCatAvailabilityInput &
	Readonly<{
		accountId: string | null | undefined;
		client?: RevenueCatPurchaseClient;
	}>;

/**
 * Build an account-scoped boundary. This never configures or calls the SDK
 * unless capability detection reaches `ready`; provider failures are mapped
 * to a public status without exposing SDK diagnostics to the UI.
 */
export function createRevenueCatPurchaseBoundary(
	options: RevenueCatPurchaseBoundaryOptions,
): RevenueCatPurchaseBoundary {
	const availability = resolveRevenueCatPurchaseAvailability(options);
	const apiKey = nonEmptyString(options.apiKey);
	let configuration: Promise<void> | undefined;

	const unavailable = (): PurchaseActionResult => {
		if (availability.state === "unsupported") return availability;
		if (availability.state === "disabled") return availability;
		return { state: "disabled", reason: "sdk_unavailable" };
	};

	const ensureConfigured = async (): Promise<PurchaseActionResult | null> => {
		if (availability.state !== "ready") return unavailable();
		const accountId = nonEmptyString(options.accountId);
		if (!accountId) return { state: "disabled", reason: "account_required" };
		if (!options.client || !apiKey) return unavailable();
		configuration ??= Promise.resolve(
			options.client.configure({ apiKey, appUserId: accountId }),
		).catch((error: unknown) => {
			configuration = undefined;
			throw error;
		});
		try {
			await configuration;
			return null;
		} catch {
			return { state: "failed", reason: "provider_error" };
		}
	};

	return {
		availability,
		purchase: async () => {
			const blocked = await ensureConfigured();
			if (blocked) return blocked;
			if (availability.state !== "ready" || !options.client)
				return { state: "disabled", reason: "sdk_unavailable" };
			try {
				await options.client.purchaseProduct(availability.productId);
				return { state: "completed" };
			} catch {
				return { state: "failed", reason: "provider_error" };
			}
		},
		restore: async () => {
			const blocked = await ensureConfigured();
			if (blocked) return blocked;
			if (availability.state !== "ready" || !options.client)
				return { state: "disabled", reason: "sdk_unavailable" };
			try {
				await options.client.restorePurchases();
				return { state: "completed" };
			} catch {
				return { state: "failed", reason: "provider_error" };
			}
		},
	};
}
