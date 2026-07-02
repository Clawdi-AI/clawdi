import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";
import { getAuth, getConfig, isLoggedIn } from "../lib/config";

// Minimal shape of a JSON Schema property we care about when mapping
// Composio tool definitions to Zod. Unknown fields are ignored.
interface JsonSchemaProperty {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean | JsonSchemaProperty;
}

type JsonSchemaObject = JsonSchemaProperty;

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: JsonSchemaObject;
	parameters?: JsonSchemaObject;
}

type ConnectorToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
type NativeToolInputShape = Record<string, z.ZodTypeAny>;
type NativeToolHandler = (
	params: Record<string, unknown>,
) => CallToolResult | Promise<CallToolResult>;
interface NativeToolRegistrar {
	registerTool(
		name: string,
		config: { description?: string; inputSchema?: NativeToolInputShape },
		handler: (params: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
	): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerNativeTool(
	server: McpServer,
	name: string,
	description: string,
	inputSchema: NativeToolInputShape,
	handler: NativeToolHandler,
) {
	const registerTool = server.registerTool.bind(server) as NativeToolRegistrar["registerTool"];
	registerTool(name, { description, inputSchema }, (params) =>
		handler(isRecord(params) ? params : {}),
	);
}

function jsonSchemaType(schema: JsonSchemaProperty): string {
	if (Array.isArray(schema.type)) {
		return schema.type.find((type) => type !== "null") ?? "string";
	}
	if (schema.type) return schema.type;
	if (schema.properties || schema.additionalProperties) return "object";
	if (schema.items) return "array";
	return "string";
}

function jsonSchemaAllowsNull(schema: JsonSchemaProperty): boolean {
	return Array.isArray(schema.type) && schema.type.includes("null");
}

function stringEnumToZod(values: string[]): z.ZodTypeAny | null {
	const [first, ...rest] = values;
	if (first === undefined) return null;
	return z.enum([first, ...rest]);
}

function jsonSchemaPropertyToZod(
	schema: JsonSchemaProperty,
	fallbackDescription: string,
): z.ZodTypeAny {
	const enumValues = schema.enum?.filter((value): value is string => typeof value === "string");
	let field: z.ZodTypeAny;
	if (enumValues && enumValues.length === schema.enum?.length) {
		field = stringEnumToZod(enumValues) ?? z.string();
	} else {
		switch (jsonSchemaType(schema)) {
			case "integer":
				field = z.number().int();
				break;
			case "number":
				field = z.number();
				break;
			case "boolean":
				field = z.boolean();
				break;
			case "array":
				field = z.array(
					schema.items
						? jsonSchemaPropertyToZod(schema.items, `${fallbackDescription} item`)
						: z.any(),
				);
				break;
			case "object":
				field = jsonSchemaObjectToZod(schema);
				break;
			default:
				field = z.string();
		}
	}

	const desc = schema.description || fallbackDescription;
	field = field.describe(desc);
	return jsonSchemaAllowsNull(schema) ? field.nullable() : field;
}

function jsonSchemaObjectToZodShape(schema: JsonSchemaObject): NativeToolInputShape {
	const shape: NativeToolInputShape = {};
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		const field = jsonSchemaPropertyToZod(prop, key);
		shape[key] = schema.required?.includes(key) ? field : field.optional();
	}

	return shape;
}

function jsonSchemaObjectToZod(schema: JsonSchemaObject): z.ZodTypeAny {
	const shape = jsonSchemaObjectToZodShape(schema);

	if (schema.properties) {
		const objectSchema = z.object(shape);
		if (schema.additionalProperties === false) {
			return objectSchema.strict();
		}
		if (typeof schema.additionalProperties === "object") {
			return objectSchema.catchall(
				jsonSchemaPropertyToZod(schema.additionalProperties, "additional property"),
			);
		}
		return objectSchema.passthrough();
	}

	if (typeof schema.additionalProperties === "object") {
		return z.record(
			z.string(),
			jsonSchemaPropertyToZod(schema.additionalProperties, "additional property"),
		);
	}
	return z.record(z.string(), z.any());
}

function buildConnectorToolSchema(tool: McpTool): {
	inputSchema: z.ZodTypeAny;
	inputShape: NativeToolInputShape;
	hasSchema: boolean;
} {
	const inputSchema = tool.inputSchema ?? tool.parameters;
	const hasSchema = Boolean(inputSchema?.properties || inputSchema?.type || inputSchema?.items);
	const fallbackShape: NativeToolInputShape = {
		arguments: z.string().optional().describe("JSON string of tool arguments"),
	};

	return {
		hasSchema,
		inputSchema: hasSchema ? jsonSchemaObjectToZod(inputSchema ?? {}) : z.object(fallbackShape),
		inputShape: inputSchema?.properties ? jsonSchemaObjectToZodShape(inputSchema) : fallbackShape,
	};
}

export function createConnectorToolDefinition(tool: McpTool) {
	const { inputSchema, inputShape, hasSchema } = buildConnectorToolSchema(tool);

	return {
		name: tool.name,
		description: tool.description || tool.name,
		inputSchema,
		inputShape,
		execute: async (params: Record<string, unknown>, callTool: ConnectorToolCaller) => {
			let args: Record<string, unknown>;
			if (hasSchema) {
				args = params;
			} else {
				const argsField = params.arguments;
				const parsedArgs =
					typeof argsField === "string" && argsField.length > 0 ? JSON.parse(argsField) : {};
				args = isRecord(parsedArgs) ? parsedArgs : {};
			}
			return await callTool(tool.name, args);
		},
	};
}

interface JsonRpcResponse {
	result?: unknown;
	error?: unknown;
}

interface ToolsListResult {
	tools?: McpTool[];
}

function requireMcpLogin(): void {
	if (!isLoggedIn()) {
		throw new Error("Not logged in. Run `clawdi auth login` first.");
	}
}

function ensureMcpLogin(): void {
	try {
		requireMcpLogin();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	}
}

const MCP_ENDPOINT_PATH = "/v1/mcp/clawdi";

async function callClawdiMcp(method: string, params?: Record<string, unknown>): Promise<unknown> {
	const config = getConfig();
	const auth = getAuth();
	const response = await fetch(`${config.apiUrl}${MCP_ENDPOINT_PATH}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth?.apiKey ?? ""}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
	});
	if (!response.ok) {
		throw new Error(`Clawdi MCP request failed (HTTP ${response.status})`);
	}
	const body = (await response.json()) as JsonRpcResponse;
	if (body.error) {
		throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
	}
	return body.result;
}

function toCallToolResult(result: unknown): CallToolResult {
	// Clawdi tools already return MCP-shaped results; connector results
	// forwarded through the backend do too. Anything else gets stringified.
	if (isRecord(result) && Array.isArray(result.content)) {
		return result as CallToolResult;
	}
	return {
		content: [
			{
				type: "text" as const,
				text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
			},
		],
	};
}

export async function createClawdiMcpServer(): Promise<McpServer> {
	requireMcpLogin();

	const server = new McpServer({
		name: "clawdi",
		version: "0.0.1",
	});

	// Every tool definition — Clawdi-native and connector — comes from the
	// backend MCP endpoint, the same source agents use when they connect to
	// /v1/mcp/clawdi directly. This process is a stdio adapter for agents
	// that can only spawn local MCP servers; each call is forwarded back to
	// the backend.
	let tools: McpTool[] = [];
	try {
		const result = (await callClawdiMcp("tools/list")) as ToolsListResult;
		tools = result?.tools ?? [];
		process.stderr.write(`Loaded ${tools.length} Clawdi tools.\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Warning: could not load Clawdi tools: ${message}\n`);
	}

	for (const tool of tools) {
		const definition = createConnectorToolDefinition(tool);
		registerNativeTool(
			server,
			definition.name,
			definition.description,
			definition.inputShape,
			async (params) => {
				try {
					const result = await definition.execute(params, (name, args) =>
						callClawdiMcp("tools/call", { name, arguments: args }),
					);
					return toCallToolResult(result);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
				}
			},
		);
	}

	return server;
}

export async function startMcpServer() {
	ensureMcpLogin();
	const server = await createClawdiMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
