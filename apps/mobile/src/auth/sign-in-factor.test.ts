import { expect, test } from "bun:test";
import { selectSecondFactor } from "./sign-in-factor";

test("Device Trust selects email verification from server-supported factors", () => {
	const factor = {
		strategy: "email_code",
		emailAddressId: "email_1",
		safeIdentifier: "a***@example.com",
	} as const;
	expect(selectSecondFactor({ supportedSecondFactors: [factor] })).toEqual(factor);
});

test("enrolled authenticator takes priority over recovery codes", () => {
	expect(
		selectSecondFactor({
			supportedSecondFactors: [{ strategy: "backup_code" }, { strategy: "totp" }],
		}),
	).toEqual({ strategy: "totp" });
});

test("unsupported email links are not treated as a supported code flow", () => {
	expect(
		selectSecondFactor({
			supportedSecondFactors: [
				{ strategy: "email_link", emailAddressId: "email_1", safeIdentifier: "a***@example.com" },
			],
		}),
	).toBeUndefined();
	expect(selectSecondFactor({ supportedSecondFactors: null })).toBeUndefined();
});
