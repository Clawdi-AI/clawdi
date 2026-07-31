import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readRuntimeApplyContext,
	readRuntimeApplyIdentity,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentitiesEqual,
} from "./apply-identity";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identityFile(root: string): string {
	const path = join(root, "runtime-apply-identity.json");
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: "clawdi.runtimeApplyIdentity.v1",
			generation: 8,
			manifestETag: '"manifest-8"',
			applyReceiptId: "apply-receipt-0008",
			bootNonce: "boot-nonce-000008",
			runtimeEnv: {
				CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
				CLAWDI_AUTH_TOKEN: "runtime-auth-token-0008",
				OPENCLAW_GATEWAY_TOKEN: "gateway-token-0008",
			},
		}),
	);
	return path;
}

describe("runtime apply identity", () => {
	test("resolves the manifest apply generation and compares the complete tuple", () => {
		expect(resolveRuntimeApplyGeneration({ generation: 2, applyGeneration: 1 })).toBe(1);
		expect(resolveRuntimeApplyGeneration({ generation: 2 })).toBe(2);
		const identity = {
			generation: 8,
			manifestETag: '"manifest-8"',
			applyReceiptId: "apply-receipt-0008",
			bootNonce: "boot-nonce-000008",
		};
		expect(runtimeApplyIdentitiesEqual(identity, { ...identity })).toBe(true);
		for (const different of [
			{ ...identity, generation: 9 },
			{ ...identity, manifestETag: '"manifest-9"' },
			{ ...identity, applyReceiptId: "apply-receipt-0009" },
			{ ...identity, bootNonce: "boot-nonce-000009" },
		]) {
			expect(runtimeApplyIdentitiesEqual(identity, different)).toBe(false);
		}
		expect(runtimeApplyIdentitiesEqual(null, null)).toBe(true);
		expect(runtimeApplyIdentitiesEqual(identity, null)).toBe(false);
	});

	test("reads identity and projected environment from an explicit file", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-apply-identity-"));
		roots.push(root);
		const path = identityFile(root);
		const context = readRuntimeApplyContext({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path });
		expect(context).toEqual({
			kind: "identity-file",
			identity: {
				generation: 8,
				manifestETag: '"manifest-8"',
				applyReceiptId: "apply-receipt-0008",
				bootNonce: "boot-nonce-000008",
			},
			runtimeEnvironment: {
				kind: "projected-environment",
				values: {
					CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
					CLAWDI_AUTH_TOKEN: "runtime-auth-token-0008",
					OPENCLAW_GATEWAY_TOKEN: "gateway-token-0008",
				},
			},
		});
		expect(readRuntimeApplyIdentity({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path })).toEqual(
			context.identity,
		);
	});

	test("discovers a supplied canonical mount path", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-discovered-apply-identity-"));
		roots.push(root);
		const path = identityFile(root);
		expect(readRuntimeApplyContext({}, path).identity.generation).toBe(8);
	});

	test("fails closed for missing, malformed, or non-canonical files", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-invalid-apply-identity-"));
		roots.push(root);
		const missing = join(root, "missing.json");
		expect(() => readRuntimeApplyContext({}, missing)).toThrow(
			/missing runtime apply identity file/,
		);
		expect(() => readRuntimeApplyContext({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: missing })).toThrow(
			/could not read runtime apply identity file/,
		);

		const invalid = join(root, "invalid.json");
		writeFileSync(invalid, JSON.stringify({ generation: 8 }));
		expect(() => readRuntimeApplyContext({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: invalid })).toThrow(
			/invalid runtime apply identity file/,
		);
		expect(() =>
			readRuntimeApplyContext({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: "relative.json" }),
		).toThrow(/canonical absolute path/);
	});

	test("rejects invalid projected runtime environment values", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-invalid-runtime-env-"));
		roots.push(root);
		const path = identityFile(root);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		parsed.runtimeEnv = { "INVALID-NAME": " secret" };
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => readRuntimeApplyContext({ CLAWDI_RUNTIME_APPLY_IDENTITY_FILE: path })).toThrow(
			/invalid runtime apply identity file/,
		);
	});
});
