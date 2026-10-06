import { Platform } from "react-native";
import Purchases, {
	type CustomerInfo,
	type MakePurchaseResult,
	type PurchasesStoreProduct,
} from "react-native-purchases";

export type RevenueCatKeys = Readonly<{
	apple?: string;
	google?: string;
}>;

export type RevenueCatPurchaseResult = Readonly<{
	customerInfo: CustomerInfo;
	transactionIdentifier?: string;
}>;

function platformKey(keys: RevenueCatKeys): string | undefined {
	if (Platform.OS === "ios") return keys.apple?.trim() || undefined;
	if (Platform.OS === "android") return keys.google?.trim() || undefined;
	return undefined;
}

function assertAppUserId(appUserId: string): string {
	const value = appUserId.trim();
	if (
		!value ||
		value.length > 255 ||
		Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		throw new Error("RevenueCat server identity is unavailable");
	return value;
}

/** Configure the native SDK with public platform key and server-selected identity. */
export function configureRevenueCat(keys: RevenueCatKeys, appUserId: string): boolean {
	const apiKey = platformKey(keys);
	if (!apiKey) return false;
	Purchases.configure({ apiKey, appUserID: assertAppUserId(appUserId) });
	return true;
}

/** Store result is evidence only; server reconciliation remains authoritative. */
export async function purchaseRevenueCatProduct(
	product: PurchasesStoreProduct,
): Promise<RevenueCatPurchaseResult> {
	const result: MakePurchaseResult = await Purchases.purchaseStoreProduct(product);
	return {
		customerInfo: result.customerInfo,
		...(result.transaction?.transactionIdentifier
			? { transactionIdentifier: result.transaction.transactionIdentifier }
			: {}),
	};
}

/** Restore is never treated as a local entitlement grant. */
export async function restoreRevenueCatPurchases(): Promise<CustomerInfo> {
	return Purchases.restorePurchases();
}
