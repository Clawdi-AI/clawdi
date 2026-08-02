import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";

function pairingErrorNormalizer(provider: "Discord" | "Telegram") {
	return {
		isAuthError: isApiAuthError,
		normalizeError: (error: unknown) =>
			isApiAuthError(error)
				? normalizeApiError(error)
				: `${provider} pairing is temporarily unavailable. Try again.`,
	};
}

export const TELEGRAM_PAIR_ERROR_NORMALIZER = pairingErrorNormalizer("Telegram");
export const DISCORD_PAIR_ERROR_NORMALIZER = pairingErrorNormalizer("Discord");
