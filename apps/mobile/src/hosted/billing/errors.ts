import { ApiClientError } from "@clawdi/shared/api";
import { billingErrorCopy } from "@clawdi/shared/view";
import { requestFailure } from "@/lib/request-failure";

/** Web's `billingErrorNormalizer`: billing-specific recovery copy for hosted billing reads. */
export const billingErrorNormalizer = {
	isAuthError: (error: unknown) => error instanceof ApiClientError && error.status === 401,
	normalizeError: (error: unknown) => billingErrorCopy(requestFailure(error)),
};
