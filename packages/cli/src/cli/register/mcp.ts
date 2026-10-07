import type { Command } from "commander";
import { loadAuthTokenFile } from "../../lib/auth-token-file.js";

export function registerMcp(program: Command): void {
	program
		.command("mcp")
		.description("Start MCP server (stdio transport, used by agents)")
		.option("--api-url <url>", "Override CLAWDI_API_URL for this MCP process")
		.option("--auth-token-file <path>", "Read CLAWDI_AUTH_TOKEN from an owner-only file")
		.action(async (opts: { apiUrl?: string; authTokenFile?: string }) => {
			const apiUrl = opts.apiUrl?.trim();
			if (apiUrl) process.env.CLAWDI_API_URL = apiUrl;
			loadAuthTokenFile(opts.authTokenFile);
			const { startMcpServer } = await import("../../mcp/server.js");
			await startMcpServer();
		});
}
