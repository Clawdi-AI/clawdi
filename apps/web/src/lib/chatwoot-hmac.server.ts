import { createHmac } from "node:crypto";

/** Creates Chatwoot's identity-validation hash entirely on the server. */
export function createChatwootIdentifierHash(
	userId: string | null | undefined,
	secret: string | null | undefined,
): string | null {
	const normalizedUserId = userId?.trim();
	const normalizedSecret = secret?.trim();
	if (!normalizedUserId || !normalizedSecret) return null;
	return createHmac("sha256", normalizedSecret).update(normalizedUserId).digest("hex");
}
