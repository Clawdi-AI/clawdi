import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
import { runtimeCommandCurrentRevisionCached } from "./runtime-systemd-reconciliation";
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
				name: "clawdi",
				ownershipIdentity,
				nativeId: "clawdi",
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
				name: "clawdi",
				ownershipIdentity,
				nativeId: "clawdi",
			},
		},
		paths,
		() => "b".repeat(64),
	);
	const prepared: PreparedHostedAgentPlugins = {
		runtime: "openclaw",
		desired: new Map([
			[
				"clawdi",
				{
					name: "clawdi",
					installation: {
						installationId: "01987b48-b641-79f2-b839-92ae5fc782fe",
						version: "1.0.0",
						agentPluginsSchema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
						source: {
							type: "github",
							url: "https://github.com/Clawdi-AI/store",
							path: "v2/plugins/clawdi",
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

test("reuses command revision until the symlink or target identity changes", () => {
	const { paths, command } = fixture();
	const firstTarget = join(root, "runtime-a");
	const secondTarget = join(root, "runtime-b");
	mkdirSync(join(command, ".."), { recursive: true });
	writeFileSync(firstTarget, "first");
	writeFileSync(secondTarget, "second");
	symlinkSync(firstTarget, command);
	let revisions = 0;
	const resolveRevision = () => {
		revisions += 1;
		return revisions.toString(16).padStart(64, "0");
	};

	expect(
		runtimeCommandCurrentRevisionCached(command, paths.userHome, paths.userHome, resolveRevision),
	).toBe("1".padStart(64, "0"));
	expect(
		runtimeCommandCurrentRevisionCached(command, paths.userHome, paths.userHome, resolveRevision),
	).toBe("1".padStart(64, "0"));
	expect(revisions).toBe(1);

	writeFileSync(firstTarget, "first target changed");
	expect(
		runtimeCommandCurrentRevisionCached(command, paths.userHome, paths.userHome, resolveRevision),
	).toBe("2".padStart(64, "0"));
	rmSync(command);
	symlinkSync(secondTarget, command);
	expect(
		runtimeCommandCurrentRevisionCached(command, paths.userHome, paths.userHome, resolveRevision),
	).toBe("3".padStart(64, "0"));
	expect(revisions).toBe(3);
});
