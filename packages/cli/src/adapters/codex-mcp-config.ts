import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CurrentCliInvocation } from "../lib/current-cli-invocation";

const CLAWDI_MCP_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?clawdi"?\s*\]/m;
const CLAWDI_MCP_DOTTED_KEY = /^\s*mcp_servers\s*\.\s*"?clawdi"?\s*[.=]/m;

function quoteTomlString(value: string): string {
	return JSON.stringify(value);
}

function mcpTable(invocation: CurrentCliInvocation): string {
	return [
		"[mcp_servers.clawdi]",
		`command = ${quoteTomlString(invocation.command)}`,
		`args = [${invocation.args.map(quoteTomlString).join(", ")}]`,
		"",
	].join("\n");
}

function hasClawdiRegistration(content: string): boolean {
	return CLAWDI_MCP_TABLE.test(content) || CLAWDI_MCP_DOTTED_KEY.test(content);
}

function readConfig(configPath: string): string {
	try {
		return readFileSync(configPath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

function writeConfigAtomically(configPath: string, content: string, mode: number): void {
	const directory = dirname(configPath);
	const tempDirectory = mkdtempSync(join(directory, ".clawdi-codex-"));
	const tempPath = join(tempDirectory, basename(configPath));
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "w", mode);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(tempPath, mode);
		renameSync(tempPath, configPath);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempDirectory, { recursive: true, force: true });
	}
}

function configMode(configPath: string): number {
	try {
		return statSync(configPath).mode & 0o7777;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0o600;
		throw error;
	}
}

/** Add Clawdi's stdio MCP table when Codex's CLI is unavailable. */
export function ensureCodexMcpServer(
	configPath: string,
	invocation: CurrentCliInvocation,
): boolean {
	const content = readConfig(configPath);
	if (hasClawdiRegistration(content)) return false;
	const table = mcpTable(invocation);
	const separator = content.length === 0 ? "" : "\n";
	writeConfigAtomically(configPath, `${content}${separator}${table}`, configMode(configPath));
	return true;
}

/** Remove only the exact table appended by ensureCodexMcpServer. */
export function removeCodexMcpServer(
	configPath: string,
	invocation: CurrentCliInvocation,
): boolean {
	const content = readConfig(configPath);
	if (!content) return false;
	const table = mcpTable(invocation);
	let prefix: string | null = null;
	if (content === table) {
		prefix = "";
	} else if (content.endsWith(`\n${table}`)) {
		prefix = content.slice(0, -(table.length + 1));
	}
	if (prefix === null) return false;
	writeConfigAtomically(configPath, prefix, configMode(configPath));
	return true;
}
