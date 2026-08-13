import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveCurrentCliInvocation } from "../lib/current-cli-invocation";
import type { PreparedHostedAgentPlugin } from "./hosted-agent-plugin-package";
import { makeRuntimeUserOwned, withRuntimeUserFileAccess } from "./runtime-user-command";

const HERMES_REMOTE_PROBE_TIMEOUT_MS = 30_000;
const HERMES_CONTROLLER_READY_TIMEOUT_MS = 5_000;
const HERMES_CANARY_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const HERMES_CANARY_MCP_HEADER = "X-Clawdi-Agent-Plugin-Canary";

const hermesCanaryReadySchema = z.object({ port: z.number().int().min(1).max(65_535) }).strict();
const hermesCanaryEvidenceSchema = z
	.object({
		mcpHeader: z.literal(true),
		mcpInitialize: z.literal(true),
		mcpInitialized: z.literal(true),
		mcpToolsList: z.literal(true),
		mcpToolCall: z.literal(true),
		inferenceSawTool: z.literal(true),
		inferenceSawToolResult: z.literal(true),
		completed: z.literal(true),
		error: z.never().optional(),
	})
	.passthrough();

interface HermesAgentPluginCanaryCommandInput {
	args: string[];
	environmentOverrides: Readonly<Record<string, string | undefined>>;
	timeoutMs: number;
}

interface HermesAgentPluginCanaryCommandResult {
	status: number | null;
	stdout: string;
}

interface HermesAgentPluginCanaryInput {
	home: string;
	runOneShot(input: HermesAgentPluginCanaryCommandInput): HermesAgentPluginCanaryCommandResult;
	withEnabledCanary(canary: PreparedHostedAgentPlugin, prove: () => void): void;
}

function waitForJsonFile<T>(path: string, schema: z.ZodType<T>, timeoutMs: number): T {
	const deadline = Date.now() + timeoutMs;
	let sawInvalidEvidence = false;
	while (Date.now() < deadline) {
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
				throw new Error("Hermes Agent Plugin canary returned unsafe evidence");
			}
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				return schema.parse(parsed);
			} catch {
				sawInvalidEvidence = true;
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	if (sawInvalidEvidence) {
		throw new Error("Hermes Agent Plugin canary returned invalid evidence");
	}
	throw new Error("Hermes Agent Plugin canary did not become ready");
}

function preparedTreeDigest(tree: PreparedHostedAgentPlugin["tree"]): string {
	const digest = createHash("sha256");
	for (const file of [...tree].sort((left, right) =>
		Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
	)) {
		const fileDigest = createHash("sha256").update(file.bytes).digest("hex");
		digest.update(
			`${file.mode.toString(8)}\0${file.path}\0${file.bytes.length}\0${fileDigest}\n`,
			"utf8",
		);
	}
	return `sha256-tree-v1:${digest.digest("hex")}`;
}

function hermesCanaryPackage(input: {
	name: string;
	nonce: string;
	port: number;
}): PreparedHostedAgentPlugin {
	const publicServerName = "clawdi-capability";
	const tree: PreparedHostedAgentPlugin["tree"] = [
		{
			path: "mcp.json",
			mode: 0o100644,
			bytes: Buffer.from(
				JSON.stringify({
					$schema: HERMES_CANARY_MCP_SCHEMA,
					mcpServers: {
						[publicServerName]: {
							type: "streamable-http",
							url: `http://127.0.0.1:${input.port}/mcp`,
							headers: {
								[HERMES_CANARY_MCP_HEADER]: `clawdi-${input.nonce}`,
							},
						},
					},
				}),
			),
		},
		{
			path: "plugin.json",
			mode: 0o100644,
			bytes: Buffer.from(
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: input.name,
					version: "1.0.0",
				}),
			),
		},
	];
	return {
		name: input.name,
		installation: {
			installationId: `canary_${input.nonce}`,
			version: "1.0.0",
			agentPluginsSchema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			source: {
				type: "github",
				url: "https://github.com/Clawdi-AI/clawdi",
				path: "",
				commit: input.nonce.padEnd(40, "0"),
			},
			contentDigest: preparedTreeDigest(tree),
			ownershipIdentity: createHash("sha256").update(`canary:${input.nonce}`).digest("hex"),
		},
		receiptNativeId: null,
		mcpServerNames: [publicServerName],
		hasStreamableHttpMcp: true,
		tree,
	};
}

function stopCanaryController(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 1_000);
	forceKill.unref();
	child.once("exit", () => clearTimeout(forceKill));
}

export function runHermesAgentPluginCanary(input: HermesAgentPluginCanaryInput): void {
	const nonce = randomBytes(16).toString("hex");
	const name = `clawdi-capability-${nonce.slice(0, 16)}`;
	const successToken = `CLAWDI_AGENT_PLUGIN_CANARY_OK_${nonce}`;
	const readyFile = join(input.home, "canary-ready.json");
	const resultFile = join(input.home, "canary-result.json");
	const invocation = resolveCurrentCliInvocation([
		"runtime",
		"agent-plugin-canary",
		"--ready-file",
		readyFile,
		"--result-file",
		resultFile,
		"--nonce",
		nonce,
		"--success-token",
		successToken,
	]);
	const controller = spawn(invocation.command, invocation.args, {
		cwd: input.home,
		env: {
			...process.env,
			HOME: input.home,
			CLAWDI_NO_UPDATE_CHECK: "1",
			CLAWDI_NO_AUTO_UPDATE: "1",
		},
		stdio: "ignore",
	});
	controller.once("error", () => undefined);
	try {
		const { port } = waitForJsonFile(
			readyFile,
			hermesCanaryReadySchema,
			HERMES_CONTROLLER_READY_TIMEOUT_MS,
		);
		const canary = hermesCanaryPackage({ name, nonce, port });
		const hermesRoot = join(input.home, ".hermes");
		mkdirSync(hermesRoot, { recursive: true, mode: 0o700 });
		makeRuntimeUserOwned(hermesRoot);
		withRuntimeUserFileAccess(() =>
			writeFileSync(
				join(hermesRoot, "config.yaml"),
				[
					"model:",
					"  default: clawdi-agent-plugin-canary",
					"  provider: custom",
					`  base_url: http://127.0.0.1:${port}/v1`,
					`  api_key: clawdi-${nonce}`,
					"  api_mode: chat_completions",
					"  context_length: 65536",
					"tools:",
					"  tool_search:",
					"    enabled: off",
					"platform_toolsets:",
					"  cli: []",
					"mcp_single_query_discovery_timeout: 10",
					"",
				].join("\n"),
				{ mode: 0o600 },
			),
		);
		input.withEnabledCanary(canary, () => {
			const result = input.runOneShot({
				args: [
					"-z",
					"Call the Clawdi capability canary tool exactly once, then return its success result.",
					"--model",
					"clawdi-agent-plugin-canary",
					"--provider",
					"custom",
				],
				environmentOverrides: {
					HERMES_DISABLE_LAZY_INSTALLS: "1",
					HERMES_SKIP_NODE_BOOTSTRAP: "1",
					HTTP_PROXY: undefined,
					HTTPS_PROXY: undefined,
					ALL_PROXY: undefined,
					http_proxy: undefined,
					https_proxy: undefined,
					all_proxy: undefined,
					NO_PROXY: "127.0.0.1,localhost",
					no_proxy: "127.0.0.1,localhost",
				},
				timeoutMs: HERMES_REMOTE_PROBE_TIMEOUT_MS,
			});
			if (result.status !== 0 || result.stdout.trim() !== successToken) throw new Error();
			waitForJsonFile(resultFile, hermesCanaryEvidenceSchema, 1_000);
		});
	} finally {
		stopCanaryController(controller);
	}
}
