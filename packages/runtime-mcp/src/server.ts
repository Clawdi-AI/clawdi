import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	CallToolResultSchema,
	ListToolsRequestSchema,
	ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { updateVaultEnv, validateVaultMaterial } from "./vault-env";

export const contextSchema = z
	.object({
		apiUrl: z.url(),
		agentId: z.uuid(),
		root: z.string().min(1),
		authorization: z.string().min(1).optional(),
	})
	.strict();
export type RuntimeContext = z.infer<typeof contextSchema>;
export type RemoteCaller = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const target = z.string().regex(/^(?:\.env(?:\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_-]+\.env)$/);
const syncArguments = z
	.object({
		path: target.default(".env.local"),
		project_id: z.uuid().optional(),
		vault_id: z.uuid().optional(),
		section: z.string().max(200).nullable().optional(),
	})
	.strict();
const localTools = [
	{
		name: "vault_sync",
		description:
			"Save Vault credentials locally in this Agent's authenticated workspace. Defaults to .env.local; path may select another env filename. First call requires project_id and vault_id, with optional section (omit for entire Vault, empty string for unsectioned fields). Later calls reuse the durable source binding; supplied source must match. Adds, updates and deletes managed fields, preserves unrelated assignments, and refuses local conflicts, tracked or non-ignored files. Returns only status, path and counts. No CLI required.",
		inputSchema: z.toJSONSchema(syncArguments, { io: "input" }),
	},
];

export function validateContext(input: unknown): RuntimeContext {
	const context = contextSchema.parse(input);
	const url = new URL(context.apiUrl);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	) {
		throw new Error("MCP API must be an HTTPS origin (HTTP only for localhost).");
	}
	context.apiUrl = url.origin;
	if (
		process.platform !== "linux" ||
		!isAbsolute(context.root) ||
		realpathSync(context.root) !== context.root
	) {
		throw new Error("MCP requires an explicit real Linux workspace directory.");
	}
	const fd = openSync(
		context.root,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		if ((fstatSync(fd).mode & 0o022) !== 0)
			throw new Error("Workspace cannot be writable by other users.");
	} finally {
		closeSync(fd);
	}
	return context;
}

export function remoteCaller(context: RuntimeContext): RemoteCaller {
	const authorization = context.authorization ?? process.env.CLAWDI_MCP_AUTHORIZATION;
	if (!authorization) throw new Error("MCP authorization is required.");
	return async (method, params) => {
		let response: Response;
		try {
			response = await fetch(`${context.apiUrl}/v1/mcp/clawdi`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(method === "tools/call" ? 390_000 : 30_000),
				headers: { Authorization: authorization, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
		} catch {
			throw new Error("Cloud MCP request failed; check the outcome before retrying a mutation.");
		}
		if (!response.ok) throw new Error("Cloud MCP request was rejected.");
		const body = z
			.object({ result: z.unknown(), error: z.unknown().optional() })
			.parse(await response.json());
		if (body.error || body.result === undefined)
			throw new Error("Cloud MCP returned an invalid response.");
		return body.result;
	};
}

export function createRuntimeMcpServer(context: RuntimeContext, callRemote: RemoteCaller): Server {
	const server = new Server({ name: "clawdi", version: "0.1.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		const remote = ListToolsResultSchema.parse(
			await callRemote("tools/list", request.params ?? {}),
		);
		// Local tools are advertised only alongside the Cloud read capability, never on remote HTTP.
		if (remote.tools.some((tool) => tool.name === "vault_resolve")) {
			remote.tools.push(...ListToolsResultSchema.parse({ tools: localTools }).tools);
		}
		return remote;
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: input } = request.params;
		if (name !== "vault_sync") {
			return CallToolResultSchema.parse(await callRemote("tools/call", request.params));
		}
		try {
			const args = syncArguments.parse(input ?? {});
			const result = await updateVaultEnv(
				join(context.root, args.path),
				async (binding) => {
					if (
						binding &&
						(binding.apiUrl !== context.apiUrl ||
							(binding.agentId && binding.agentId !== context.agentId))
					) {
						throw new Error("Vault binding context changed; nothing was written.");
					}
					if (
						binding &&
						((args.project_id !== undefined && args.project_id !== binding.projectId) ||
							(args.vault_id !== undefined && args.vault_id !== binding.vaultId) ||
							(args.section !== undefined && args.section !== binding.section))
					) {
						throw new Error("Source differs from the saved Vault binding; choose a new file.");
					}
					const source = binding
						? {
								project_id: binding.projectId,
								vault_id: binding.vaultId,
								section: binding.section,
							}
						: args.project_id && args.vault_id
							? {
									project_id: args.project_id,
									vault_id: args.vault_id,
									section: args.section ?? null,
								}
							: undefined;
					if (!source)
						throw new Error(
							"No Vault binding exists; supply project_id and vault_id to vault_sync.",
						);
					const response = CallToolResultSchema.parse(
						await callRemote("tools/call", {
							name: "vault_resolve",
							arguments: { material: { ...source, agent_id: context.agentId } },
						}),
					);
					const content = response.content[0];
					if (response.isError || !content || content.type !== "text")
						throw new Error("Cloud rejected Vault material access.");
					const raw: unknown = JSON.parse(content.text);
					const identity = z.object({ agent_id: z.uuid() }).parse(raw);
					const material = validateVaultMaterial(raw);
					if (
						identity.agent_id !== context.agentId ||
						material.project_id !== source.project_id ||
						material.vault_id !== source.vault_id ||
						material.section !== source.section
					) {
						throw new Error("Vault response identity changed; nothing was written.");
					}
					return { apiUrl: context.apiUrl, material };
				},
				{ root: context.root, agentId: context.agentId },
			);
			return { content: [{ type: "text", text: JSON.stringify({ status: "synced", ...result }) }] };
		} catch (error) {
			const safe =
				error instanceof Error &&
				/^(Local conflict:|Unmanaged local variable|Vault binding context changed|Vault field was replaced|No Vault binding exists|Target must|Source differs|Vault response identity changed)/.test(
					error.message,
				);
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: safe
							? error.message
							: "Vault file synchronization failed; verify source access, env filename, Git ignore rules and workspace permissions. No secret values were returned.",
					},
				],
			};
		}
	});
	return server;
}
