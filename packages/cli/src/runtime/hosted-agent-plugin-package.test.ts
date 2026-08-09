import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import {
	AGENT_PLUGIN_SECRET_BINDINGS_UNSUPPORTED_ERROR,
	HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR,
	prepareHostedAgentPluginPackages,
} from "./hosted-agent-plugin-package";
import type { RuntimeManifest } from "./manifest-contract";
import { AGENT_PLUGINS_SCHEMA_1_0_0 } from "./manifest-resources";
import { getRuntimePaths } from "./paths";
import { ensureRuntimeStateDirs } from "./state";

const originalEnv = { ...process.env };
let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	process.env = { ...originalEnv };
});

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function treeDigest(files: Readonly<Record<string, Buffer>>): string {
	const digest = createHash("sha256");
	for (const path of Object.keys(files).sort((left, right) =>
		Buffer.compare(Buffer.from(left), Buffer.from(right)),
	)) {
		const bytes = files[path];
		if (!bytes) throw new Error("missing test file");
		digest.update(`100644\0${path}\0${bytes.length}\0${sha256(bytes)}\n`);
	}
	return `sha256-tree-v1:${digest.digest("hex")}`;
}

function archiveResponse(bytes: Buffer): Response {
	const body = new ArrayBuffer(bytes.length);
	new Uint8Array(body).set(bytes);
	return new Response(body, { status: 200 });
}

async function archive(files: Readonly<Record<string, Buffer>>): Promise<Buffer> {
	const source = join(root, "source");
	const repositoryRoot = "agent-plugins-aaaaaaaa";
	const pluginRoot = join(source, repositoryRoot, "plugins", "acme.tools");
	for (const [path, bytes] of Object.entries(files)) {
		const target = join(pluginRoot, ...path.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
	}
	const chunks: Buffer[] = [];
	const stream = tar.create({ cwd: source, gzip: true }, [repositoryRoot]);
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function manifest(
	runtime: "openclaw" | "hermes",
	contentDigest: string,
	secretRefs: Record<string, string> = {},
): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_agent_plugins",
		environmentId: "env_agent_plugins",
		instanceId: "hri_agent_plugins",
		generation: 1,
		issuedAt: "2026-08-09T00:00:00.000Z",
		runtime,
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: { [runtime]: { enabled: true, services: {} } },
		projection: {
			sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
			agentPlugins: {
				schemaVersion: 1,
				installations: {
					"acme.tools": {
						installationId: "install_acme_tools",
						version: "1.2.3",
						agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
						source: {
							type: "github",
							url: "https://github.com/acme/agent-plugins",
							path: "plugins/acme.tools",
							commit: "a".repeat(40),
						},
						contentDigest,
						secretRefs,
					},
				},
			},
		},
		recovery: {},
	};
}

function paths() {
	root = mkdtempSync(join(tmpdir(), "agent-plugin-package-test-"));
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	const runtimePaths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(runtimePaths);
	return runtimePaths;
}

function pluginFiles(mcp?: Record<string, unknown>): Record<string, Buffer> {
	return {
		"plugin.json": Buffer.from(
			JSON.stringify({
				$schema: AGENT_PLUGINS_SCHEMA_1_0_0,
				name: "acme.tools",
				version: "1.2.3",
			}),
		),
		"skills/review/SKILL.md": Buffer.from("---\nname: review\ndescription: Review\n---\n"),
		...(mcp ? { "mcp.json": Buffer.from(JSON.stringify(mcp)) } : {}),
	};
}

describe("Hosted Agent Plugin package preparation", () => {
	test("rejects a digest mismatch before native commands can run", async () => {
		const runtimePaths = paths();
		const bytes = await archive(pluginFiles());
		let fetches = 0;
		await expect(
			prepareHostedAgentPluginPackages(
				manifest("openclaw", `sha256-tree-v1:${"f".repeat(64)}`),
				runtimePaths,
				{
					fetcher: async () => {
						fetches += 1;
						return archiveResponse(bytes);
					},
				},
			),
		).rejects.toThrow("content digest");
		expect(fetches).toBe(1);
	});

	test("accepts the Hermes Skills and stdio MCP subset", async () => {
		const runtimePaths = paths();
		const files = pluginFiles({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: { review: { type: "stdio", command: "node", args: ["server.js"] } },
		});
		const bytes = await archive(files);
		const prepared = await prepareHostedAgentPluginPackages(
			manifest("hermes", treeDigest(files)),
			runtimePaths,
			{ fetcher: async () => archiveResponse(bytes) },
		);
		if (!prepared) throw new Error("missing prepared Agent Plugin fixture");
		expect(prepared.desired.get("acme.tools")?.installation.contentDigest).toBe(treeDigest(files));
	});

	test("rejects Hermes remote MCP before an isolated native probe", async () => {
		const runtimePaths = paths();
		const files = pluginFiles({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: {
				remote: {
					type: "streamable-http",
					url: "https://mcp.example.test",
					headers: { Authorization: "literal-value" },
				},
			},
		});
		const bytes = await archive(files);
		await expect(
			prepareHostedAgentPluginPackages(manifest("hermes", treeDigest(files)), runtimePaths, {
				fetcher: async () => archiveResponse(bytes),
			}),
		).rejects.toThrow(HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR);
	});

	test("rejects secretRefs without fetching or disclosing the reference", async () => {
		const runtimePaths = paths();
		const secretRef = "secret://agent-plugins/acme.tools/private-token";
		let fetches = 0;
		let error: unknown;
		try {
			await prepareHostedAgentPluginPackages(
				manifest("openclaw", `sha256-tree-v1:${"a".repeat(64)}`, {
					"api-token": secretRef,
				}),
				runtimePaths,
				{
					fetcher: async () => {
						fetches += 1;
						return new Response(null, { status: 200 });
					},
				},
			);
		} catch (caught) {
			error = caught;
		}
		if (!(error instanceof Error)) throw new Error("expected package preparation to fail");
		expect(error.message).toBe(AGENT_PLUGIN_SECRET_BINDINGS_UNSUPPORTED_ERROR);
		expect(error.message).not.toContain(secretRef);
		expect(fetches).toBe(0);
	});
});
