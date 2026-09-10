#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntimeMcpServer, remoteCaller, validateContext } from "./server";

try {
	const { values } = parseArgs({
		options: {
			config: { type: "string" },
			"api-url": { type: "string" },
			"agent-id": { type: "string" },
			workspace: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (values.config && (values["api-url"] || values["agent-id"] || values.workspace))
		throw new Error("Ambiguous context");
	const context = validateContext(
		values.config
			? JSON.parse(readFileSync(values.config, "utf8"))
			: {
					apiUrl: values["api-url"],
					agentId: values["agent-id"],
					root: values.workspace,
				},
	);
	await createRuntimeMcpServer(context, remoteCaller(context)).connect(new StdioServerTransport());
} catch {
	process.stderr.write(
		"Clawdi MCP could not start. Verify the explicit workspace, Agent identity, API origin and authentication configuration.\n",
	);
	process.exitCode = 1;
}
