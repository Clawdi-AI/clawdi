import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeApplyContext } from "./apply-identity";
import { assertHostedRuntimeContract } from "./hosted-runtime-contract";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const applyContext: RuntimeApplyContext = {
	kind: "context-file",
	backend: "incus",
	identity: {
		generation: 1,
		manifestETag: '"test-manifest"',
		applyReceiptId: "test-apply-receipt",
		bootNonce: "test-boot-nonce",
	},
	cliPackageSpec: "clawdi@1.2.3",
	manifestSource: {
		type: "http",
		url: "https://runtime.test/v1/runtime/manifest",
		auth: { type: "bearer", token: "test-token" },
	},
};

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("hosted runtime convergence contract", () => {
	test("rejects a hosted convergence whose resolved HOME is not the tenant home", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = "/root";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_RUNTIME_UID = "10001";
		process.env.CLAWDI_RUNTIME_GID = "10001";

		expect(() =>
			assertHostedRuntimeContract(getRuntimePaths(), applyContext, {
				platformRoots: "deferred",
			}),
		).toThrow("hosted runtime HOME must resolve to /home/clawdi; resolved /root");
	});

	test("rejects a hosted CLI state root inside the tenant home", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_HOME = "/home/clawdi/.clawdi";

		expect(() =>
			assertHostedRuntimeContract(getRuntimePaths(), applyContext, {
				platformRoots: "deferred",
				resolveUserIdentity: () => ({ uid: 10_001, gid: 10_001 }),
			}),
		).toThrow("hosted CLAWDI_HOME must be outside the tenant home");
	});

	test("rejects a hosted CLI state root outside the service-state directory family", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_HOME = "/var/cache/clawdi-user";

		expect(() =>
			assertHostedRuntimeContract(getRuntimePaths(), applyContext, {
				platformRoots: "deferred",
				resolveUserIdentity: () => ({ uid: 10_001, gid: 10_001 }),
			}),
		).toThrow("hosted CLAWDI_HOME must be an absolute sibling of /var/lib/clawdi");
	});

	test("rejects a hosted convergence whose runtime user is wrong", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		process.env.CLAWDI_RUNTIME_USER = "root";

		expect(() =>
			assertHostedRuntimeContract(getRuntimePaths(), applyContext, {
				platformRoots: "deferred",
			}),
		).toThrow("hosted runtime user must be clawdi; resolved root");
	});

	test("rejects a hosted runtime account that resolves to the wrong identity", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";

		expect(() =>
			assertHostedRuntimeContract(getRuntimePaths(), applyContext, {
				platformRoots: "deferred",
				resolveUserIdentity: () => ({ uid: 0, gid: 0 }),
			}),
		).toThrow("hosted runtime user clawdi resolved to root identity 0:0");
	});

	test("rejects convergence when hosted mode was not selected explicitly", () => {
		process.env.CLAWDI_RUNTIME_MODE = "local";
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		process.env.CLAWDI_RUNTIME_USER = "clawdi";

		expect(() =>
			assertHostedRuntimeContract(getRuntimePaths(), applyContext, {
				platformRoots: "deferred",
			}),
		).toThrow("hosted convergence requires CLAWDI_RUNTIME_MODE=hosted explicitly");
	});
});
