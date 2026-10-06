import type { SignInResource, SignInSecondFactor } from "@clerk/expo/types";

export type SupportedSecondFactor = Extract<
	SignInSecondFactor,
	{ strategy: "email_code" | "phone_code" | "totp" | "backup_code" }
>;

export function selectSecondFactor(
	attempt: Pick<SignInResource, "supportedSecondFactors">,
): SupportedSecondFactor | undefined {
	const factors = attempt.supportedSecondFactors ?? [];
	// Prefer enrolled MFA; backup codes remain a fallback when no other method exists.
	for (const strategy of ["totp", "email_code", "phone_code", "backup_code"] as const) {
		const factor = factors.find((candidate) => candidate.strategy === strategy);
		if (factor && factor.strategy !== "email_link") return factor;
	}
	return undefined;
}
