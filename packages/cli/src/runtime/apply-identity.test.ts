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
const originalAllowTestInstallers = process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS;
const originalRuntimeContextFile = process.env.CLAWDI_RUNTIME_TEST_CONTEXT_FILE;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalAllowTestInstallers === undefined) {
		delete process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS;
	} else {
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = originalAllowTestInstallers;
	}
	if (originalRuntimeContextFile === undefined) {
		delete process.env.CLAWDI_RUNTIME_TEST_CONTEXT_FILE;
	} else {
		process.env.CLAWDI_RUNTIME_TEST_CONTEXT_FILE = originalRuntimeContextFile;
	}
});

function contextFile(root: string): string {
	const path = join(root, "runtime-context.json");
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: "clawdi.runtimeContext.v3",
			backend: "incus",
			apply: {
				generation: 8,
				manifestETag: '"manifest-8"',
				applyReceiptId: "apply-receipt-0008",
				bootNonce: "boot-nonce-000008",
			},
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
				auth: { type: "bearer", token: "runtime-auth-token-0008" },
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

	test("reads the complete typed context from the supplied canonical file", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-apply-identity-"));
		roots.push(root);
		const path = contextFile(root);
		const context = readRuntimeApplyContext(path);
		expect(context).toEqual({
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: 8,
				manifestETag: '"manifest-8"',
				applyReceiptId: "apply-receipt-0008",
				bootNonce: "boot-nonce-000008",
			},
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
				auth: { type: "bearer", token: "runtime-auth-token-0008" },
			},
		});
		expect(readRuntimeApplyIdentity(path)).toEqual(context.identity);
	});

	test("allows an explicit process fixture path only behind the test gate", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-context-fixture-"));
		roots.push(root);
		const path = contextFile(root);
		process.env.CLAWDI_RUNTIME_TEST_CONTEXT_FILE = path;
		expect(() => readRuntimeApplyContext()).toThrow(/available only with/);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		expect(readRuntimeApplyContext().identity.generation).toBe(8);

		process.env.CLAWDI_RUNTIME_TEST_CONTEXT_FILE = "relative/runtime-context.json";
		expect(() => readRuntimeApplyContext()).toThrow(/canonical absolute path/);
	});

	test("reads legacy v2 context without treating its CLI field as authority", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-paired-cli-fixture-"));
		roots.push(root);
		const path = contextFile(root);
		const parsed: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
		parsed.schemaVersion = "clawdi.runtimeContext.v2";
		parsed.cliPackageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-local.tgz";
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => readRuntimeApplyContext(path)).toThrow(/CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1/);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		expect(readRuntimeApplyContext(path).identity.generation).toBe(8);

		parsed.cliPackageSpec = "/tmp/clawdi-local.tgz";
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => readRuntimeApplyContext(path)).toThrow(/invalid runtime context file/);
	});

	test("fails closed for missing, malformed, or legacy context files", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-invalid-apply-identity-"));
		roots.push(root);
		const missing = join(root, "missing.json");
		expect(() => readRuntimeApplyContext(missing)).toThrow(/could not read runtime context file/);

		const invalid = join(root, "invalid.json");
		writeFileSync(invalid, JSON.stringify({ generation: 8 }));
		expect(() => readRuntimeApplyContext(invalid)).toThrow(/invalid runtime context file/);

		const legacy = join(root, "legacy.json");
		writeFileSync(legacy, JSON.stringify({ schemaVersion: "clawdi.runtimeApplyIdentity.v1" }));
		expect(() => readRuntimeApplyContext(legacy)).toThrow(/invalid runtime context file/);
	});

	test("requires the attested Incus backend in every runtime context", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-missing-runtime-backend-"));
		roots.push(root);
		const path = contextFile(root);
		const parsed: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
		delete parsed.backend;
		writeFileSync(path, JSON.stringify(parsed));

		expect(() => readRuntimeApplyContext(path)).toThrow(/backend: Invalid input/);
	});

	test("rejects the removed runtimeEnv parallel secret authority", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-removed-runtime-env-"));
		roots.push(root);
		const path = contextFile(root);
		const parsed: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
		parsed.runtimeEnv = { OPENCLAW_GATEWAY_TOKEN: "legacy-token" };
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => readRuntimeApplyContext(path)).toThrow(/invalid runtime context file/);
	});

	test.each([
		["source", "/etc/clawdi/runtime-source.json"],
		["sourcePath", "/etc/clawdi/runtime-source.json"],
		["manifestUrl", "https://runtime.test/v1/runtime/manifest"],
		["authTokenEnv", "CLAWDI_AUTH_TOKEN"],
		["runtimeMode", "hosted"],
	])("rejects removed top-level runtime context field %s", (field, value) => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-removed-runtime-context-field-"));
		roots.push(root);
		const path = contextFile(root);
		const parsed: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
		parsed[field] = value;
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => readRuntimeApplyContext(path)).toThrow(/invalid runtime context file/);
	});

	test.each([
		["env", "CLAWDI_AUTH_TOKEN"],
		["path", "/run/secrets/clawdi-auth-token"],
		["tokenRef", "secret://clawdi/auth-token"],
	])("rejects removed manifest source auth field %s", (field, value) => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-removed-manifest-auth-field-"));
		roots.push(root);
		const path = contextFile(root);
		const parsed: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
		const manifestSource = parsed.manifestSource;
		if (typeof manifestSource !== "object" || manifestSource === null) {
			throw new Error("expected manifestSource fixture");
		}
		const auth = Reflect.get(manifestSource, "auth");
		if (typeof auth !== "object" || auth === null) throw new Error("expected auth fixture");
		Reflect.set(auth, field, value);
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => readRuntimeApplyContext(path)).toThrow(/invalid runtime context file/);
	});
});
