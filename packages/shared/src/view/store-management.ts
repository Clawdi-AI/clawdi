import type { DeployComponents } from "../api";
import type { StorePlatform } from "../api/store-client";
import { billingTermLabel } from "./billing-format";
import {
	type ComputeSubscriptionCardView,
	computeSubscriptionPlanLabel,
} from "./compute-subscription-card";
import { formatShortDate } from "./format";

export type StoreManagement = DeployComponents["schemas"]["StoreManagement"];
export type StoreManagementProvider = StoreManagement["provider"];
export type StoreManagementState = StoreManagement["state"];

export const STORE_MANAGEMENT_URLS = {
	app_store: "https://apps.apple.com/account/subscriptions",
	play_store:
		"https://play.google.com/store/account/subscriptions?sku=ai.clawdi.app.compute&package=ai.clawdi.app",
	test_store: null,
} as const satisfies Record<StoreManagementProvider, string | null>;

export function storeManagementProvider(
	management: StoreManagement | null | undefined,
): StoreManagementProvider | null {
	return management?.provider ?? null;
}

export function storeManagementState(
	management: StoreManagement | null | undefined,
): StoreManagementState | null {
	return management?.state ?? null;
}

export function isStoreManagementOnPlatform(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): boolean {
	return management?.provider === platform;
}

export function isStoreManagementOnOtherStore(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): boolean {
	return (
		management?.provider !== undefined &&
		management.provider !== "test_store" &&
		management.provider !== platform
	);
}

/**
 * Returns the official management page only for the store on the current
 * platform. Test Store has no management page, and cross-platform rows have no
 * actionable URL.
 */
export function storeManagementUrl(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): string | null {
	if (!management || !isStoreManagementOnPlatform(management, platform)) return null;
	return STORE_MANAGEMENT_URLS[management.provider];
}

export type StoreManagementPresentation = {
	provider: StoreManagementProvider | null;
	state: StoreManagementState | null;
	isOnThisPlatform: boolean;
	isOnOtherStore: boolean;
	managementUrl: string | null;
};

export function storeManagementPresentation(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): StoreManagementPresentation {
	return {
		provider: storeManagementProvider(management),
		state: storeManagementState(management),
		isOnThisPlatform: isStoreManagementOnPlatform(management, platform),
		isOnOtherStore: isStoreManagementOnOtherStore(management, platform),
		managementUrl: storeManagementUrl(management, platform),
	};
}

/** Read-only copy for store-billed compute; surfaces never sell or manage these rows. */
export const storeSubscriptionCopy = {
	providers: {
		app_store: "App Store",
		play_store: "Google Play",
		test_store: "Test Store",
	} satisfies Record<StoreManagementProvider, string>,
	unknownProvider: "App Store or Google Play",
	term: "Term",
	payment: "Payment",
	schedule: "Schedule",
	availableInApp: "Available in the Clawdi app",
	renewalIssue: "Update the payment method on your device to keep this subscription.",
} as const;

const STORE_BILLED_THROUGH = {
	app_store: "the App Store",
	play_store: "Google Play",
	test_store: "Test Store",
} as const satisfies Record<StoreManagementProvider, string>;

export function storeProviderLabel(management: StoreManagement | null | undefined): string {
	const provider = storeManagementProvider(management);
	return provider
		? storeSubscriptionCopy.providers[provider]
		: storeSubscriptionCopy.unknownProvider;
}

/** Test Store purchases are non-production evidence and have no device management page. */
export function storeBillingNotice(management: StoreManagement | null | undefined): string {
	const provider = storeManagementProvider(management);
	if (provider === "test_store") return `Billed through ${STORE_BILLED_THROUGH.test_store}.`;
	const store = provider
		? STORE_BILLED_THROUGH[provider]
		: `the ${storeSubscriptionCopy.unknownProvider}`;
	return `Billed through ${store}. Manage it on your device.`;
}

export function storeAgentDeletionNotice(management: StoreManagement | null | undefined): string {
	const notice = `Deleting this Agent doesn't cancel your ${storeProviderLabel(management)} subscription.`;
	return storeManagementProvider(management) === "test_store"
		? notice
		: `${notice} Manage it on your device.`;
}

type StoreSubscriptionStatus = ComputeSubscriptionCardView["status"];

const STORE_SUBSCRIPTION_STATUS = new Map<string, StoreSubscriptionStatus>([
	["active", { label: "Active", tone: "success" }],
	["grace", { label: "Grace period", tone: "warning" }],
	["lapsed", { label: "Billing issue", tone: "destructive" }],
	["paused", { label: "Paused", tone: "neutral" }],
	["canceled_pending_end", { label: "Canceling", tone: "warning" }],
	["expired", { label: "Expired", tone: "neutral" }],
	["revoked", { label: "Ended", tone: "neutral" }],
	["owner_terminated", { label: "Ended", tone: "neutral" }],
	["conflict_hold", { label: "Needs attention", tone: "warning" }],
]);

const STORE_TERMINAL_STATES = new Set(["expired", "revoked", "owner_terminated"]);

/** Status from the store contract; `fallback` covers rows whose contract is not projected. */
export function storeSubscriptionStatus(
	management: StoreManagement | null | undefined,
	fallback: StoreSubscriptionStatus,
): StoreSubscriptionStatus {
	const state = storeManagementState(management);
	if (state === null) return fallback;
	return STORE_SUBSCRIPTION_STATUS.get(state) ?? { label: "Unavailable", tone: "neutral" };
}

/** Grace and lapse are store billing failures; recovery happens only on the purchasing device. */
export function storeRenewalIssue(management: StoreManagement | null | undefined): boolean {
	const state = storeManagementState(management);
	return state === "grace" || state === "lapsed";
}

export type StoreSubscriptionDate = { kind: "renews" | "ends" | "ended"; at: string };

/** The store's next renewal or end date, when the contract state makes it meaningful. */
export function storeSubscriptionDate(
	management: StoreManagement | null | undefined,
): StoreSubscriptionDate | null {
	const at = management?.renews_or_ends_at;
	if (!management || !at) return null;
	const state = management.state;
	if (STORE_TERMINAL_STATES.has(state)) return { kind: "ended", at };
	if (state === "canceled_pending_end") return { kind: "ends", at };
	if (state === "active" || state === "grace") {
		return { kind: management.auto_renews ? "renews" : "ends", at };
	}
	return null;
}

const STORE_SCHEDULE_VERB = { renews: "Renews", ends: "Ends", ended: "Ended" } as const;

export function storeSubscriptionSchedule(management: StoreManagement | null | undefined): string {
	const date = storeSubscriptionDate(management);
	return date ? `${STORE_SCHEDULE_VERB[date.kind]} ${formatShortDate(date.at)}` : "Unavailable";
}

/** Store prices are set per storefront, so store rows show no Clawdi price. */
export function storeSubscriptionCardView({
	planSlug,
	billingTermMonths,
	management,
	fallbackStatus,
}: {
	planSlug: string;
	billingTermMonths: number;
	management: StoreManagement | null | undefined;
	fallbackStatus: StoreSubscriptionStatus;
}): ComputeSubscriptionCardView {
	return {
		status: storeSubscriptionStatus(management, fallbackStatus),
		plan: computeSubscriptionPlanLabel(planSlug),
		commercialFacts: [
			{ label: storeSubscriptionCopy.term, value: billingTermLabel(billingTermMonths) },
			{ label: storeSubscriptionCopy.payment, value: storeProviderLabel(management) },
			{ label: storeSubscriptionCopy.schedule, value: storeSubscriptionSchedule(management) },
		],
	};
}
