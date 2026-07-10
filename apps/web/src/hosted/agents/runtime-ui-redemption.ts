export interface RuntimeUiRedemptionResult {
	url: string;
}

export interface RuntimeUiPopup {
	opener: unknown;
	location: {
		href: string;
	};
	closed?: boolean;
	close?: () => void;
}

export type RuntimeUiPopupOpen = (
	url: string,
	target: "_blank",
	features?: string,
) => RuntimeUiPopup | null;

export type RuntimeUiOpenResult = "opened_reserved_popup" | "opened_direct" | "blocked";

export async function openRuntimeUiWithRedemption({
	redeem,
	openPopup,
}: {
	redeem: () => Promise<RuntimeUiRedemptionResult>;
	openPopup: RuntimeUiPopupOpen;
}): Promise<RuntimeUiOpenResult> {
	const reserved = openPopup("about:blank", "_blank");
	if (reserved) {
		try {
			reserved.opener = null;
		} catch {
			// Some browsers expose opener as readonly for cross-process popups.
		}
	}
	let redemption: RuntimeUiRedemptionResult;
	try {
		redemption = await redeem();
	} catch (error) {
		try {
			reserved?.close?.();
		} catch {
			// A blocked or cross-process popup may refuse programmatic close.
		}
		throw error;
	}
	if (reserved) {
		reserved.location.href = redemption.url;
		return "opened_reserved_popup";
	}
	const direct = openPopup(redemption.url, "_blank", "noopener,noreferrer");
	return direct ? "opened_direct" : "blocked";
}
