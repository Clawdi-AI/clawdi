import { describe, expect, test } from "bun:test";
import {
	readRuntimeApplyIdentityFromEnv,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentityEnvironment,
} from "./apply-identity";

const completeEnvironment = {
	CLAWDI_RUNTIME_GENERATION: "7",
	CLAWDI_RUNTIME_MANIFEST_ETAG: '"manifest-7"',
	CLAWDI_RUNTIME_APPLY_RECEIPT_ID: "apply-receipt-0007",
	CLAWDI_RUNTIME_BOOT_NONCE: "boot-nonce-000007",
};

describe("runtime apply identity environment", () => {
	test("resolves explicit apply identity with one named legacy checkpoint fallback", () => {
		expect(resolveRuntimeApplyGeneration({ generation: 2, applyGeneration: 1 })).toBe(1);
		expect(resolveRuntimeApplyGeneration({ generation: 2, applyGeneration: 3 })).toBe(3);
		expect(resolveRuntimeApplyGeneration({ generation: 2 })).toBe(2);
	});

	test("projects apply identity independently of checkpoint generation", () => {
		const generation = resolveRuntimeApplyGeneration({ generation: 2, applyGeneration: 3 });
		expect(
			runtimeApplyIdentityEnvironment({
				generation,
				manifestETag: '"manifest-3"',
				applyReceiptId: "apply-receipt-0003",
				bootNonce: "boot-nonce-000003",
			}),
		).toEqual({
			CLAWDI_RUNTIME_GENERATION: "3",
			CLAWDI_RUNTIME_MANIFEST_ETAG: '"manifest-3"',
			CLAWDI_RUNTIME_APPLY_RECEIPT_ID: "apply-receipt-0003",
			CLAWDI_RUNTIME_BOOT_NONCE: "boot-nonce-000003",
		});
	});

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
