import { describe, expect, test } from "bun:test";
import {
	RUNTIME_APPLY_IDENTITY_HEADERS,
	readRuntimeApplyIdentityFromEnv,
	runtimeApplyIdentityEnvironment,
	runtimeApplyIdentityHeaders,
} from "./apply-identity";

const completeEnv = {
	CLAWDI_RUNTIME_GENERATION: "7",
	CLAWDI_RUNTIME_MANIFEST_ETAG: '"manifest-generation-7"',
	CLAWDI_RUNTIME_APPLY_RECEIPT_ID: "apply-receipt-0007",
	CLAWDI_RUNTIME_BOOT_NONCE: "boot-nonce-000007",
};

describe("runtime apply identity environment", () => {
	test("reads one complete canonical tuple and maps it to request headers", () => {
		const identity = readRuntimeApplyIdentityFromEnv(completeEnv);

		expect(identity).toEqual({
			generation: 7,
			manifestETag: '"manifest-generation-7"',
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
		});
		expect(runtimeApplyIdentityHeaders(identity)).toEqual({
			[RUNTIME_APPLY_IDENTITY_HEADERS.generation]: "7",
			[RUNTIME_APPLY_IDENTITY_HEADERS.manifestETag]: '"manifest-generation-7"',
			[RUNTIME_APPLY_IDENTITY_HEADERS.applyReceiptId]: "apply-receipt-0007",
			[RUNTIME_APPLY_IDENTITY_HEADERS.bootNonce]: "boot-nonce-000007",
		});
		expect(runtimeApplyIdentityEnvironment(identity)).toEqual(completeEnv);
	});

	test("rejects incomplete, non-canonical, and invalid tuples", () => {
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				...completeEnv,
				CLAWDI_RUNTIME_BOOT_NONCE: undefined,
			}),
		).toThrow("missing runtime apply identity environment: CLAWDI_RUNTIME_BOOT_NONCE");
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				...completeEnv,
				CLAWDI_RUNTIME_GENERATION: "07",
			}),
		).toThrow("CLAWDI_RUNTIME_GENERATION must be a canonical positive integer");
		expect(() =>
			readRuntimeApplyIdentityFromEnv({
				...completeEnv,
				CLAWDI_RUNTIME_MANIFEST_ETAG: ' "manifest-generation-7"',
			}),
		).toThrow("manifestETag: must not contain surrounding whitespace");
	});
});
