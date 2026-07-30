import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readRuntimeApplyContext,
	readRuntimeApplyIdentity,
	readRuntimeApplyIdentityFromEnv,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentityEnvironment,
	runtimeApplyIdentityServiceEnvironment,
} from "./apply-identity";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";

const completeEnvironment = {
	CLAWDI_RUNTIME_GENERATION: "7",
	CLAWDI_RUNTIME_MANIFEST_ETAG: '"manifest-7"',
	CLAWDI_RUNTIME_APPLY_RECEIPT_ID: "apply-receipt-0007",
	CLAWDI_RUNTIME_BOOT_NONCE: "boot-nonce-000007",
};

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe("runtime apply identity file", () => {
	test("reads the complete canonical tuple from the configured file", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-apply-identity-"));
		roots.push(root);
		const path = join(root, "runtime-apply-identity.json");
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeApplyIdentity.v1",
				generation: 8,
				manifestETag: '"manifest-8"',
				applyReceiptId: "apply-receipt-0008",
				bootNonce: "boot-nonce-000007",
				runtimeEnv: {
					CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
					CLAWDI_RUNTIME_MANIFEST_URL: "https://runtime.test/v1/runtime/manifest",
					CLAWDI_AUTH_TOKEN: "runtime-auth-token-0008",
					OPENCLAW_GATEWAY_TOKEN: "gateway-token-0008",
				},
			}),
		);

		expect(
			readRuntimeApplyIdentity({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path,
				...completeEnvironment,
			}),
		).toEqual({
			generation: 8,
			manifestETag: '"manifest-8"',
			applyReceiptId: "apply-receipt-0008",
			bootNonce: "boot-nonce-000007",
		});
		expect(
			readRuntimeApplyContext({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path,
				...completeEnvironment,
			}),
		).toEqual({
			kind: "identity-file",
			identity: {
				generation: 8,
				manifestETag: '"manifest-8"',
				applyReceiptId: "apply-receipt-0008",
				bootNonce: "boot-nonce-000007",
			},
			runtimeEnvironment: {
				kind: "projected-environment",
				values: {
					CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
					CLAWDI_RUNTIME_MANIFEST_URL: "https://runtime.test/v1/runtime/manifest",
					CLAWDI_AUTH_TOKEN: "runtime-auth-token-0008",
					OPENCLAW_GATEWAY_TOKEN: "gateway-token-0008",
				},
			},
			sourcePath: path,
		});
		expect(
			runtimeApplyIdentityServiceEnvironment({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path,
				...completeEnvironment,
			}),
		).toEqual({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path });
	});

	test("fails closed instead of falling back when the configured file is unavailable or invalid", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-apply-identity-invalid-"));
		roots.push(root);
		const missing = join(root, "missing.json");
		expect(() =>
			readRuntimeApplyIdentity({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: missing,
				...completeEnvironment,
			}),
		).toThrow(/could not read runtime apply identity file/);

		const invalid = join(root, "invalid.json");
		writeFileSync(invalid, JSON.stringify({ generation: 8 }));
		expect(() =>
			readRuntimeApplyIdentity({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: invalid,
				...completeEnvironment,
			}),
		).toThrow(/invalid runtime apply identity file/);

		writeFileSync(
			invalid,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeApplyIdentity.v1",
				generation: 8,
				manifestETag: '"manifest-8"',
				applyReceiptId: "apply-receipt-0008",
				bootNonce: "boot-nonce-000008",
				runtimeEnv: { "INVALID-NAME": " secret" },
			}),
		);
		expect(() =>
			readRuntimeApplyIdentity({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: invalid,
				...completeEnvironment,
			}),
		).toThrow(/invalid runtime apply identity file/);
		expect(() =>
			readRuntimeApplyIdentity({
				CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: "relative.json",
				...completeEnvironment,
			}),
		).toThrow(/canonical absolute path/);
	});

	test("uses the legacy environment only when no file path is configured", () => {
		const missingDiscoveryPath = join(tmpdir(), "clawdi-missing-runtime-apply-identity.json");
		expect(readRuntimeApplyIdentity(completeEnvironment, missingDiscoveryPath)).toEqual(
			readRuntimeApplyIdentityFromEnv(completeEnvironment),
		);
		expect(readRuntimeApplyContext(completeEnvironment, missingDiscoveryPath)).toMatchObject({
			kind: "process-environment",
			runtimeEnvironment: {
				kind: "process-environment",
				values: completeEnvironment,
			},
		});
	});

	test("discovers the canonical mount before consulting the legacy environment", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-discovered-apply-identity-"));
		roots.push(root);
		const discovered = join(root, "runtime-apply-identity.json");
		writeFileSync(
			discovered,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeApplyIdentity.v1",
				generation: 9,
				manifestETag: '"manifest-9"',
				applyReceiptId: "apply-receipt-0009",
				bootNonce: "boot-nonce-000009",
				runtimeEnv: {
					CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
					CLAWDI_AUTH_TOKEN: "discovered-token",
					OPENCLAW_GATEWAY_TOKEN: "discovered-gateway-token",
				},
			}),
		);

		const context = readRuntimeApplyContext(
			{ ...completeEnvironment, STALE_ONLY_PROCESS_TOKEN: "stale-process-token" },
			discovered,
		);
		expect(context).toEqual({
			kind: "identity-file",
			identity: {
				generation: 9,
				manifestETag: '"manifest-9"',
				applyReceiptId: "apply-receipt-0009",
				bootNonce: "boot-nonce-000009",
			},
			runtimeEnvironment: {
				kind: "projected-environment",
				values: {
					CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
					CLAWDI_AUTH_TOKEN: "discovered-token",
					OPENCLAW_GATEWAY_TOKEN: "discovered-gateway-token",
				},
			},
			sourcePath: discovered,
		});
		const clonedSecrets = {
			...Object.fromEntries(
				Object.entries(
					normalizeSecretValues({
						"env://OPENCLAW_GATEWAY_TOKEN": "discovered-gateway-token",
					}),
				),
			),
		};
		expect(
			runtimeSecretValue(clonedSecrets, "env://OPENCLAW_GATEWAY_TOKEN", context.runtimeEnvironment),
		).toBe("discovered-gateway-token");
		expect(
			runtimeSecretValue(
				clonedSecrets,
				"env://STALE_ONLY_PROCESS_TOKEN",
				context.runtimeEnvironment,
			),
		).toBeNull();
		expect(runtimeApplyIdentityServiceEnvironment(completeEnvironment, discovered)).toEqual({
			CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: discovered,
		});

		writeFileSync(discovered, JSON.stringify({ generation: 9 }));
		expect(() => readRuntimeApplyContext(completeEnvironment, discovered)).toThrow(
			/invalid runtime apply identity file/,
		);
	});
});
