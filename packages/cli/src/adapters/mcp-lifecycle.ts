import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { reconcileLocalHermesMcp } from "../commands/hermes-mcp";
import { errMessage } from "../lib/errors";

export interface McpLifecycle {
	register(): Promise<void>;
	unregister(): Promise<void>;
}

function commandLifecycle(input: {
	label: string;
	listCommand?: readonly [command: string, ...args: string[]];
	registeredPattern?: RegExp;
	registerCommand: readonly [command: string, ...args: string[]];
	unregisterCommand: readonly [command: string, ...args: string[]];
	manualRegister: string;
	registeredMessage: string;
}): McpLifecycle {
	return {
		async register() {
			if (input.listCommand && input.registeredPattern) {
				try {
					const [command, ...args] = input.listCommand;
					const listed = execFileSync(command, args, {
						stdio: ["ignore", "pipe", "pipe"],
						env: process.env,
						encoding: "utf8",
					});
					if (input.registeredPattern.test(listed)) {
						console.log(chalk.gray(`✓ MCP server already registered in ${input.label}`));
						return;
					}
				} catch {
					// A failed probe is not evidence that registration cannot work.
				}
			}
			try {
				const [command, ...args] = input.registerCommand;
				execFileSync(command, args, { stdio: "pipe", env: process.env });
				console.log(chalk.green(input.registeredMessage));
			} catch {
				console.log(chalk.yellow(`⚠ Could not auto-register MCP server in ${input.label}.`));
				console.log(chalk.gray(`  Run manually: ${input.manualRegister}`));
			}
		},
		async unregister() {
			try {
				const [command, ...args] = input.unregisterCommand;
				execFileSync(command, args, { stdio: "pipe", env: process.env });
				console.log(chalk.green(`${input.label}: removed MCP server registration`));
			} catch {
				console.log(
					chalk.gray(`${input.label}: MCP server already absent (or removal not supported)`),
				);
			}
		},
	};
}

export const claudeMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "Claude Code",
	listCommand: ["claude", "mcp", "list"],
	registeredPattern: /^\s*clawdi:\s/m,
	registerCommand: [
		"claude",
		"mcp",
		"add-json",
		"clawdi",
		JSON.stringify({ type: "stdio", command: "clawdi", args: ["mcp"] }),
		"--scope",
		"user",
	],
	unregisterCommand: ["claude", "mcp", "remove", "clawdi"],
	manualRegister:
		'claude mcp add-json clawdi \'{"type":"stdio","command":"clawdi","args":["mcp"]}\' --scope user',
	registeredMessage: "✓ MCP server registered in Claude Code",
});

export const codexMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "Codex",
	listCommand: ["codex", "mcp", "list"],
	registeredPattern: /^\s*clawdi\b/m,
	registerCommand: ["codex", "mcp", "add", "clawdi", "--", "clawdi", "mcp"],
	unregisterCommand: ["codex", "mcp", "remove", "clawdi"],
	manualRegister: "codex mcp add clawdi -- clawdi mcp",
	registeredMessage: "✓ MCP server registered in Codex",
});

export const openClawMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "OpenClaw",
	registerCommand: [
		"openclaw",
		"mcp",
		"set",
		"clawdi",
		JSON.stringify({ command: "clawdi", args: ["mcp"] }),
	],
	unregisterCommand: ["openclaw", "mcp", "unset", "clawdi"],
	manualRegister: `openclaw mcp set clawdi '${JSON.stringify({ command: "clawdi", args: ["mcp"] })}'`,
	registeredMessage: "✓ MCP server registered in OpenClaw",
});

export const hermesMcpLifecycle: McpLifecycle = {
	async register() {
		try {
			if (!reconcileLocalHermesMcp(true)) {
				console.log(chalk.gray("✓ MCP server already registered in Hermes"));
				return;
			}
			console.log(chalk.green("✓ MCP server registered in Hermes"));
		} catch (error) {
			console.log(chalk.yellow(`⚠ Could not register MCP server in Hermes: ${errMessage(error)}`));
			console.log(chalk.gray("  Check with: hermes config get mcp_servers --json"));
		}
	},
	async unregister() {
		try {
			if (reconcileLocalHermesMcp(false)) {
				console.log(chalk.green("Hermes: removed MCP server registration"));
			} else {
				console.log(chalk.gray("Hermes: MCP server already absent"));
			}
		} catch (error) {
			console.log(
				chalk.yellow(`Hermes: could not remove MCP server registration (${errMessage(error)})`),
			);
			console.log(chalk.gray("  Check with: hermes config get mcp_servers --json"));
		}
	},
};
