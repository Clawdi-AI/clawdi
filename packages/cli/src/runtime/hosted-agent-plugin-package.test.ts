import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import {
	AGENT_PLUGIN_SECRET_BINDINGS_UNSUPPORTED_ERROR,
	cleanupHostedAgentPluginTransientArchives,
	gcHostedAgentPluginArchives,
	HERMES_AGENT_PLUGIN_GIT_TRANSPORT_UNSUPPORTED_ERROR,
	type PreparedHostedAgentPluginInstallation,
	type PreparedHostedAgentPlugins,
	prepareHostedAgentPluginPackages,
	writeHostedAgentPluginReceipt,
} from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	hostedAgentPluginCommands,
	proveHostedAgentPluginCapabilities,
} from "./hosted-agent-plugin-runtime";
import {
	AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR,
	AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR,
	type RuntimeManifest,
} from "./manifest-contract";
import {
	AGENT_PLUGINS_SCHEMA_1_0_0,
	hostedAgentPluginInstallationSchema,
} from "./manifest-resources";
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

async function archive(
	files: Readonly<Record<string, Buffer>>,
	packagePath = "plugins/acme.tools",
	repositoryFiles: Readonly<Record<string, Buffer>> = {},
): Promise<Buffer> {
	const source = join(root, "source");
	const repositoryRoot = "agent-plugins-aaaaaaaa";
	const pluginRoot = join(source, repositoryRoot, ...packagePath.split("/").filter(Boolean));
	for (const [path, bytes] of Object.entries(files)) {
		const target = join(pluginRoot, ...path.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
	}
	for (const [path, bytes] of Object.entries(repositoryFiles)) {
		const target = join(source, repositoryRoot, ...path.split("/"));
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
	sourcePath = "plugins/acme.tools",
	identity: { commit?: string; installationId?: string; version?: string } = {},
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
						installationId: identity.installationId ?? "install_acme_tools",
						version: identity.version ?? "1.2.3",
						agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
						source: {
							type: "github",
							url: "https://github.com/acme/agent-plugins",
							path: sourcePath,
							commit: identity.commit ?? "a".repeat(40),
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

function pluginFiles(
	mcp?: Record<string, unknown>,
	version = "1.2.3",
	extensions?: Record<string, unknown>,
): Record<string, Buffer> {
	return {
		"plugin.json": Buffer.from(
			JSON.stringify({
				$schema: AGENT_PLUGINS_SCHEMA_1_0_0,
				name: "acme.tools",
				version,
				...(extensions ? { extensions } : {}),
			}),
		),
		"skills/review/SKILL.md": Buffer.from("---\nname: review\ndescription: Review\n---\n"),
		...(mcp ? { "mcp.json": Buffer.from(JSON.stringify(mcp)) } : {}),
	};
}

function clawdiExtension(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		display: { name: "Acme Tools", category: "tools" },
		...fields,
	};
}

function permissiveNativeRunner(onCommand: () => void): HostedAgentPluginCommandRunner {
	return {
		available: () => true,
		run: () => {
			onCommand();
			return { status: 0, stdout: "[]", stderr: "" };
		},
	};
}

describe("Hosted Agent Plugin package preparation", () => {
	test("rejects installations outside a hosted v2 bundle before fetching", async () => {
		const runtimePaths = paths();
		const invalidManifest = manifest("openclaw", `sha256-tree-v1:${"f".repeat(64)}`);
		if (!invalidManifest.projection) throw new Error("missing Agent Plugin fixture projection");
		delete invalidManifest.projection.sourceBundleVersion;
		let fetches = 0;

		await expect(
			prepareHostedAgentPluginPackages(invalidManifest, runtimePaths, {
				fetcher: async () => {
					fetches += 1;
					throw new Error("unexpected fetch");
				},
			}),
		).rejects.toThrow(AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR);
		expect(fetches).toBe(0);
	});

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
		const files = pluginFiles(
			{
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					review: {
						type: "stdio",
						command: "node",
						args: ["server.js"],
						env: {
							PUBLIC_MODE: "review",
							PLUGIN_PATH: `\${PLUGIN_ROOT}/server.js`,
							DATA_PATH: `\${PLUGIN_DATA}/cache`,
							LITERAL_REFERENCE: `\${OTHER}/settings`,
							PUBLIC_LABEL: "sk-public-value",
						},
					},
				},
			},
			"1.2.3",
			{
				"ai.clawdi": clawdiExtension({
					compatibility: { runtimes: ["hermes"], executables: ["node"] },
				}),
			},
		);
		const bytes = await archive(files);
		const prepared = await prepareHostedAgentPluginPackages(
			manifest("hermes", treeDigest(files)),
			runtimePaths,
			{ fetcher: async () => archiveResponse(bytes) },
		);
		if (!prepared) throw new Error("missing prepared Agent Plugin fixture");
		expect(prepared.desired.get("acme.tools")?.installation.contentDigest).toBe(treeDigest(files));
		expect(prepared.desired.get("acme.tools")?.mcpServerNames).toEqual(["review"]);
	});

	test("accepts Hermes streamable-http and still rejects portable SSE", async () => {
		const runtimePaths = paths();
		const files = pluginFiles({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: {
				remote: {
					type: "streamable-http",
					url: "https://mcp.example.test?mode=public",
					headers: { "X-Public-Metadata": "sk-public-value" },
				},
			},
		});
		const bytes = await archive(files);
		const prepared = await prepareHostedAgentPluginPackages(
			manifest("hermes", treeDigest(files)),
			runtimePaths,
			{ fetcher: async () => archiveResponse(bytes) },
		);
		expect(prepared?.desired.get("acme.tools")).toMatchObject({
			mcpServerNames: ["remote"],
			hasStreamableHttpMcp: true,
		});

		const sseFiles = pluginFiles({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: { remote: { type: "sse", url: "https://mcp.example.test/sse" } },
		});
		await expect(
			prepareHostedAgentPluginPackages(manifest("hermes", treeDigest(sseFiles)), runtimePaths, {
				fetcher: async () => archiveResponse(await archive(sseFiles)),
			}),
		).rejects.toThrow("only support the portable streamable-http");
	});

	test("allows explicit loopback HTTP MCP URLs but rejects 127-prefixed DNS names", async () => {
		const runtimePaths = paths();
		const filesFor = (url: string) =>
			pluginFiles({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { remote: { type: "streamable-http", url } },
			});
		for (const url of ["http://127.42.0.1/mcp", "http://[::1]/mcp"]) {
			const files = filesFor(url);
			await expect(
				prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(files)), runtimePaths, {
					fetcher: async () => archiveResponse(await archive(files)),
				}),
			).resolves.not.toBeNull();
		}
		const invalid = filesFor("http://127.example.com/mcp");
		await expect(
			prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(invalid)), runtimePaths, {
				fetcher: async () => archiveResponse(await archive(invalid)),
			}),
		).rejects.toThrow("Agent Plugin remote MCP URL must use HTTPS");
	});

	test("rejects remote MCP header values with HTTP control characters", async () => {
		const runtimePaths = paths();
		const files = pluginFiles({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: {
				remote: {
					type: "streamable-http",
					url: "https://mcp.example.test",
					headers: { "X-Public-Metadata": "invalid\0value" },
				},
			},
		});
		await expect(
			prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(files)), runtimePaths, {
				fetcher: async () => archiveResponse(await archive(files)),
			}),
		).rejects.toThrow("Agent Plugin remote MCP headers are invalid");
	});

	test("validates repo-root packages and excludes sibling files for a subpath source", async () => {
		const rootPaths = paths();
		const rootFiles = pluginFiles();
		const rootArchive = await archive(rootFiles, "");
		const preparedRoot = await prepareHostedAgentPluginPackages(
			manifest("openclaw", treeDigest(rootFiles), {}, ""),
			rootPaths,
			{ fetcher: async () => archiveResponse(rootArchive) },
		);
		expect(preparedRoot?.desired.get("acme.tools")?.tree.map((file) => file.path)).toEqual(
			Object.keys(rootFiles).sort(),
		);

		rmSync(root, { recursive: true, force: true });
		root = "";
		const subpathPaths = paths();
		const subpathFiles = pluginFiles();
		const subpathArchive = await archive(subpathFiles, "plugins/acme.tools", {
			"plugins/sibling/private.txt": Buffer.from("must-not-cross-source-boundary"),
		});
		const preparedSubpath = await prepareHostedAgentPluginPackages(
			manifest("openclaw", treeDigest(subpathFiles)),
			subpathPaths,
			{ fetcher: async () => archiveResponse(subpathArchive) },
		);
		expect(preparedSubpath?.desired.get("acme.tools")?.tree.map((file) => file.path)).toEqual(
			Object.keys(subpathFiles).sort(),
		);
	});

	test("rejects Python-casefold-equivalent paths before caching", async () => {
		const runtimePaths = paths();
		const files = {
			...pluginFiles(),
			"skills/straße/SKILL.md": Buffer.from(
				"---\nname: straße\ndescription: Unicode spelling\n---\n",
			),
			"skills/strasse/SKILL.md": Buffer.from(
				"---\nname: strasse\ndescription: ASCII spelling\n---\n",
			),
		};
		const bytes = await archive(files);
		await expect(
			prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(files)), runtimePaths, {
				fetcher: async () => archiveResponse(bytes),
			}),
		).rejects.toThrow("case-fold path collision");
	});

	test("rejects invalid or secret-bearing package components before native execution", async () => {
		const runtimePaths = paths();
		const credentialTemplate = `\${TOKEN}`;
		const cases: Array<{ label: string; files: Record<string, Buffer> }> = [
			{
				label: "Skill frontmatter",
				files: {
					...pluginFiles(),
					"skills/review/SKILL.md": Buffer.from("---\nname: other\ndescription: Review\n---\n"),
				},
			},
			{
				label: "Skill unknown frontmatter field",
				files: {
					...pluginFiles(),
					"skills/review/SKILL.md": Buffer.from(
						"---\nname: review\ndescription: Review\nunknown: rejected\n---\n",
					),
				},
			},
			{
				label: "Clawdi secret slots",
				files: pluginFiles(undefined, "1.2.3", {
					"ai.clawdi": clawdiExtension({
						configuration: { secretSlots: {} },
					}),
				}),
			},
			{
				label: "Clawdi unknown extension field",
				files: pluginFiles(undefined, "1.2.3", {
					"ai.clawdi": clawdiExtension({
						unknown: true,
					}),
				}),
			},
			{
				label: "Clawdi incompatible runtime",
				files: pluginFiles(undefined, "1.2.3", {
					"ai.clawdi": clawdiExtension({
						compatibility: { runtimes: ["openclaw"] },
					}),
				}),
			},
			{
				label: "Clawdi undeclared executable",
				files: pluginFiles(
					{
						$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
						mcpServers: { invalid: { type: "stdio", command: "node" } },
					},
					"1.2.3",
					{
						"ai.clawdi": clawdiExtension({
							compatibility: { runtimes: ["hermes"] },
						}),
					},
				),
			},
			...[
				{ command: "node server.js" },
				{ command: "node", args: ["valid", 42] },
				{ command: "node", env: { plugin_root: "override" } },
				{ command: "node", env: { API_TOKEN: "literal-secret" } },
				{ command: "node", env: { PUBLIC_VALUE: "sk_123456789012" } },
				{ command: "node", env: { PUBLIC_URL: "https://user:password@example.test" } },
				{ command: "node", env: { PUBLIC_MODE: "a", public_mode: "b" } },
				{ command: "node", env: { "INVALID-NAME": "public" } },
				{ command: "node", cwd: "../outside" },
			].map((server, index) => ({
				label: `stdio ${index}`,
				files: pluginFiles({
					$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
					mcpServers: { invalid: { type: "stdio", ...server } },
				}),
			})),
			...[
				{ type: "streamable-http", url: `https://mcp.example.test/${credentialTemplate}` },
				{ type: "streamable-http", url: "https://mcp.example.test/path#" },
				{ type: "streamable-http", url: "https://@mcp.example.test/path" },
				{
					type: "streamable-http",
					url: "https://mcp.example.test",
					headers: { Authorization: "Bearer literal-secret" },
				},
				{
					type: "streamable-http",
					url: "https://mcp.example.test",
					headers: { "X-Public-Metadata": credentialTemplate },
				},
				{
					type: "streamable-http",
					url: "https://mcp.example.test",
					headers: { "X-Public-Metadata": "Bearer literal-secret" },
				},
			].map((server, index) => ({
				label: `remote ${index}`,
				files: pluginFiles({
					$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
					mcpServers: { invalid: server },
				}),
			})),
		];
		let nativeCommands = 0;
		const runner = permissiveNativeRunner(() => {
			nativeCommands += 1;
		});
		for (const fixture of cases) {
			const bytes = await archive(fixture.files);
			await expect(
				(async () => {
					const prepared = await prepareHostedAgentPluginPackages(
						manifest("hermes", treeDigest(fixture.files)),
						runtimePaths,
						{ fetcher: async () => archiveResponse(bytes) },
					);
					if (!prepared) throw new Error("missing prepared Agent Plugin fixture");
					proveHostedAgentPluginCapabilities({
						prepared,
						commands: hostedAgentPluginCommands(runtimePaths.userHome),
						runner,
					});
				})(),
			).rejects.toThrow();
			expect(nativeCommands).toBe(0);
		}
	});

	test("boots offline only from a verified cache and never fetches for missing or corrupt cache", async () => {
		const runtimePaths = paths();
		const files = pluginFiles();
		const bytes = await archive(files);
		const online = await prepareHostedAgentPluginPackages(
			manifest("openclaw", treeDigest(files)),
			runtimePaths,
			{ fetcher: async () => archiveResponse(bytes) },
		);
		if (!online) throw new Error("missing prepared Agent Plugin fixture");
		const ownership = online.desired.get("acme.tools")?.installation.ownershipIdentity;
		if (!ownership) throw new Error("missing cache ownership fixture");
		let fetches = 0;
		const offlineFetcher = async (): Promise<Response> => {
			fetches += 1;
			throw new Error("offline fetch must not run");
		};
		await expect(
			prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(files)), runtimePaths, {
				offline: true,
				fetcher: offlineFetcher,
			}),
		).resolves.toBeTruthy();

		const cacheRoot = join(runtimePaths.cacheRoot, "agent-plugins", ownership);
		writeFileSync(join(cacheRoot, "source.tar.gz"), "corrupt");
		await expect(
			prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(files)), runtimePaths, {
				offline: true,
				fetcher: offlineFetcher,
			}),
		).rejects.toThrow("offline Agent Plugin cache is invalid");
		rmSync(cacheRoot, { recursive: true });
		await expect(
			prepareHostedAgentPluginPackages(manifest("openclaw", treeDigest(files)), runtimePaths, {
				offline: true,
				fetcher: offlineFetcher,
			}),
		).rejects.toThrow("offline Agent Plugin cache is missing");
		expect(fetches).toBe(0);
	});

	test("preserves receipt-owned cache when another runtime rejects its package policy", async () => {
		const runtimePaths = paths();
		const files = {
			...pluginFiles(),
			".gitattributes": Buffer.from("* text=auto\n"),
		};
		const bytes = await archive(files);
		const openClawManifest = manifest("openclaw", treeDigest(files));
		const prepared = await prepareHostedAgentPluginPackages(openClawManifest, runtimePaths, {
			fetcher: async () => archiveResponse(bytes),
		});
		const installation = prepared?.desired.get("acme.tools")?.installation;
		if (!installation) throw new Error("missing prepared Agent Plugin fixture");
		writeHostedAgentPluginReceipt(
			{
				schemaVersion: "clawdi.hostedAgentPluginReceipts.v2",
				runtime: "openclaw",
				installations: {
					"acme.tools": { ...installation, nativeId: "acme-tools" },
				},
			},
			runtimePaths,
		);
		let fetches = 0;
		const unexpectedFetcher = async (): Promise<Response> => {
			fetches += 1;
			throw new Error("receipt-owned cache must not be refetched");
		};

		await expect(
			prepareHostedAgentPluginPackages(manifest("hermes", treeDigest(files)), runtimePaths, {
				fetcher: unexpectedFetcher,
			}),
		).rejects.toThrow(HERMES_AGENT_PLUGIN_GIT_TRANSPORT_UNSUPPORTED_ERROR);
		const rollback = await prepareHostedAgentPluginPackages(openClawManifest, runtimePaths, {
			offline: true,
			fetcher: unexpectedFetcher,
		});
		expect(rollback?.rollback.get("acme.tools")?.installation.ownershipIdentity).toBe(
			installation.ownershipIdentity,
		);
		expect(fetches).toBe(0);
	});

	test("garbage collection removes stale owned archives without touching unknown or symlink entries", async () => {
		const runtimePaths = paths();
		const previousFiles = pluginFiles(undefined, "1.2.2");
		const previousBytes = await archive(previousFiles);
		const previous = await prepareHostedAgentPluginPackages(
			manifest("openclaw", treeDigest(previousFiles), {}, "plugins/acme.tools", {
				commit: "b".repeat(40),
				installationId: "install_acme_tools_previous",
				version: "1.2.2",
			}),
			runtimePaths,
			{ fetcher: async () => archiveResponse(previousBytes) },
		);
		const previousInstallation = previous?.desired.get("acme.tools")?.installation;
		if (!previousInstallation) throw new Error("missing previous Agent Plugin fixture");

		const currentFiles = pluginFiles(undefined, "1.2.3");
		const currentBytes = await archive(currentFiles);
		const current = await prepareHostedAgentPluginPackages(
			manifest("openclaw", treeDigest(currentFiles)),
			runtimePaths,
			{ fetcher: async () => archiveResponse(currentBytes) },
		);
		const currentInstallation = current?.desired.get("acme.tools")?.installation;
		if (!currentInstallation) throw new Error("missing current Agent Plugin fixture");
		const container = join(runtimePaths.cacheRoot, "agent-plugins");
		const unknownOwnership = "f".repeat(64);
		mkdirSync(join(container, unknownOwnership), { recursive: true });
		writeFileSync(join(container, unknownOwnership, "user-data"), "unknown");
		const invalidLookalike = "d".repeat(64);
		mkdirSync(join(container, invalidLookalike), { recursive: true });
		writeFileSync(join(container, invalidLookalike, "source.tar.gz"), "not-a-managed-archive");
		writeFileSync(join(container, invalidLookalike, "receipt.json"), "{}");
		const unknown = join(container, "leave-me-alone");
		mkdirSync(unknown, { recursive: true });
		writeFileSync(join(unknown, "data"), "unknown");
		const symlinkTarget = join(root, "outside-cache");
		mkdirSync(symlinkTarget);
		const symlink = join(container, "e".repeat(64));
		symlinkSync(symlinkTarget, symlink);

		gcHostedAgentPluginArchives(
			{
				schemaVersion: "clawdi.hostedAgentPluginReceipts.v2",
				runtime: "openclaw",
				installations: { "acme.tools": { ...currentInstallation, nativeId: "acme-tools" } },
			},
			runtimePaths,
		);

		expect(existsSync(join(container, previousInstallation.ownershipIdentity))).toBe(false);
		expect(existsSync(join(container, currentInstallation.ownershipIdentity))).toBe(true);
		expect(readFileSync(join(container, unknownOwnership, "user-data"), "utf8")).toBe("unknown");
		expect(readFileSync(join(container, invalidLookalike, "receipt.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(unknown, "data"), "utf8")).toBe("unknown");
		expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
		expect(existsSync(symlinkTarget)).toBe(true);
	});

	test("capability failure removes only this attempt's new desired archive", async () => {
		const runtimePaths = paths();
		const previousFiles = pluginFiles(undefined, "1.2.2");
		const previousBytes = await archive(previousFiles);
		const previous = await prepareHostedAgentPluginPackages(
			manifest("openclaw", treeDigest(previousFiles), {}, "plugins/acme.tools", {
				commit: "b".repeat(40),
				installationId: "install_acme_tools_previous",
				version: "1.2.2",
			}),
			runtimePaths,
			{ fetcher: async () => archiveResponse(previousBytes) },
		);
		const previousInstallation = previous?.desired.get("acme.tools")?.installation;
		if (!previousInstallation) throw new Error("missing previous Agent Plugin fixture");
		writeHostedAgentPluginReceipt(
			{
				schemaVersion: "clawdi.hostedAgentPluginReceipts.v2",
				runtime: "openclaw",
				installations: {
					"acme.tools": { ...previousInstallation, nativeId: "acme-tools" },
				},
			},
			runtimePaths,
		);

		const desiredFiles = pluginFiles(undefined, "1.2.3");
		const desiredBytes = await archive(desiredFiles);
		let prepared: PreparedHostedAgentPlugins | null = null;
		let liveCommands = 0;
		const runner: HostedAgentPluginCommandRunner = {
			available: () => false,
			run: () => {
				liveCommands += 1;
				return { status: 0, stdout: "", stderr: "" };
			},
		};
		let desiredInstallation: PreparedHostedAgentPluginInstallation | undefined;
		try {
			const capabilityPrepared = await prepareHostedAgentPluginPackages(
				manifest("openclaw", treeDigest(desiredFiles)),
				runtimePaths,
				{ fetcher: async () => archiveResponse(desiredBytes) },
			);
			prepared = capabilityPrepared;
			desiredInstallation = capabilityPrepared?.desired.get("acme.tools")?.installation;
			if (!capabilityPrepared || !desiredInstallation) {
				throw new Error("missing desired Agent Plugin fixture");
			}
			expect(capabilityPrepared.transientCacheOwnerships).toEqual(
				new Set([desiredInstallation.ownershipIdentity]),
			);
			expect(() =>
				proveHostedAgentPluginCapabilities({
					prepared: capabilityPrepared,
					commands: hostedAgentPluginCommands(runtimePaths.userHome),
					runner,
				}),
			).toThrow(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
		} finally {
			cleanupHostedAgentPluginTransientArchives(prepared, runtimePaths);
		}

		const container = join(runtimePaths.cacheRoot, "agent-plugins");
		if (!desiredInstallation) throw new Error("missing desired Agent Plugin fixture");
		expect(liveCommands).toBe(0);
		expect(existsSync(join(container, desiredInstallation.ownershipIdentity))).toBe(false);
		expect(existsSync(join(container, previousInstallation.ownershipIdentity))).toBe(true);
	});

	test("rejects secretRefs without fetching or disclosing the reference", async () => {
		const runtimePaths = paths();
		const secretRef = "secret://agent-plugins/acme.tools/private-token";
		const installation = manifest("openclaw", `sha256-tree-v1:${"a".repeat(64)}`).projection
			?.agentPlugins?.installations["acme.tools"];
		if (!installation) throw new Error("missing Agent Plugin installation fixture");
		expect(
			hostedAgentPluginInstallationSchema.safeParse({
				...installation,
				secretRefs: { "api.token": secretRef },
			}).success,
		).toBe(false);
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
