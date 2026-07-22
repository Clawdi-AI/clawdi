import { describe, expect, test } from "bun:test";
import { readRuntimeApplyIdentityFromEnv, runtimeApplyIdentityEnvironment } from "./apply-identity";

const completeEnvironment = {
	CLAWDI_RUNTIME_GENERATION: "7",
	CLAWDI_RUNTIME_MANIFEST_ETAG: '"manifest-7"',
	CLAWDI_RUNTIME_APPLY_RECEIPT_ID: "apply-receipt-0007",
	CLAWDI_RUNTIME_BOOT_NONCE: "boot-nonce-000007",
};

describe("runtime apply identity environment", () => {
	test("returns null when the entire tuple is absent", () => {
		expect(readRuntimeApplyIdentityFromEnv({})).toBeNull();
	});

	test("reads only the complete canonical four-variable tuple", () => {
		const identity = readRuntimeApplyIdentityFromEnv(completeEnvironment);
		expect(identity).toEqual({
			generation: 7,
			manifestETag: '"manifest-7"',
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
		});
		expect(runtimeApplyIdentityEnvironment(identity)).toEqual(completeEnvironment);
	});

	test("rejects partial, non-canonical, and unsafe tuples", () => {
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				CLAWDI_RUNTIME_GENERATION: "7",
			}),
		).toThrow(/incomplete runtime apply identity environment/);
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				...completeEnvironment,
				CLAWDI_RUNTIME_GENERATION: "07",
			}),
		).toThrow(/canonical positive integer/);
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				...completeEnvironment,
				CLAWDI_RUNTIME_MANIFEST_ETAG: ' "manifest-7"',
			}),
		).toThrow(/surrounding whitespace/);
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				...completeEnvironment,
				CLAWDI_RUNTIME_GENERATION: String(Number.MAX_SAFE_INTEGER + 1),
			}),
		).toThrow(/invalid runtime apply identity environment/);
	});
});
