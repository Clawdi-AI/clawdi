import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearHostedAgentPluginCapabilityProofUnlessOwned,
	hostedAgentPluginCapabilityHeader,
	hostedAgentPluginCapabilityProofPath,
	writeHostedAgentPluginCapabilityProof,
} from "./hosted-agent-plugin-capability";
import type { PreparedHostedAgentPlugins } from "./hosted-agent-plugin-package";
import { hostedAgentPluginCommands } from "./hosted-agent-plugin-runtime";
import { getRuntimePaths } from "./paths";
import { ensureRuntimeStateDirs } from "./state";

const originalEnv = { ...process.env };
let root = "";

afterEach(() => {
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function fixture() {
	root = mkdtempSync(join(tmpdir(), "clawdi-agent-plugin-capability-test-"));
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	const command = hostedAgentPluginCommands(paths.userHome).openclaw;
	const ownershipIdentity = "a".repeat(64);
	return { paths, command, ownershipIdentity };
}

test("binds native capability proof to command and package ownership", () => {
	const { paths, command, ownershipIdentity } = fixture();
	writeHostedAgentPluginCapabilityProof(
		{
			runtime: "openclaw",
			command,
			package: {
				runtime: "openclaw",
				command,
				name: "clawdi-cloud",
				ownershipIdentity,
				nativeId: "clawdi-cloud",
			},
		},
		paths,
		() => "b".repeat(64),
	);
	const proofPath = hostedAgentPluginCapabilityProofPath(paths);
	expect(statSync(proofPath).mode & 0o777).toBe(0o600);
	expect(hostedAgentPluginCapabilityHeader(paths, () => "b".repeat(64))).toBe(
		`v1:openclaw:${ownershipIdentity}:${"b".repeat(64)}`,
	);

	expect(hostedAgentPluginCapabilityHeader(paths, () => "c".repeat(64))).toBeNull();
	expect(existsSync(proofPath)).toBe(false);
});

test("clears proof when desired package ownership changes", () => {
	const { paths, command, ownershipIdentity } = fixture();
	writeHostedAgentPluginCapabilityProof(
		{
			runtime: "openclaw",
			command,
			package: {
				runtime: "openclaw",
				command,
				name: "clawdi-cloud",
				ownershipIdentity,
				nativeId: "clawdi-cloud",
			},
		},
		paths,
		() => "b".repeat(64),
	);
	const prepared: PreparedHostedAgentPlugins = {
		runtime: "openclaw",
		desired: new Map([
			[
				"clawdi-cloud",
				{
					name: "clawdi-cloud",
					installation: {
						installationId: "first-party:clawdi-cloud",
						version: "1.0.0",
						agentPluginsSchema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
						source: {
							type: "github",
							url: "https://github.com/Clawdi-AI/store",
							path: "v2/plugins/clawdi-cloud",
							commit: "e".repeat(40),
						},
						contentDigest: `sha256-tree-v1:${"f".repeat(64)}`,
						ownershipIdentity: "d".repeat(64),
					},
					receiptNativeId: null,
					mcpServerNames: [],
					hasStreamableHttpMcp: true,
					tree: [],
				},
			],
		]),
		previousReceipt: null,
		rollback: new Map(),
		transientCacheOwnerships: new Set(),
	};

	clearHostedAgentPluginCapabilityProofUnlessOwned(prepared, paths);
	expect(existsSync(hostedAgentPluginCapabilityProofPath(paths))).toBe(false);
});
