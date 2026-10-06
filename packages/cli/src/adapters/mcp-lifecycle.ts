import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import chalk from "chalk";
import { reconcileAllLocalHermesMcp } from "../commands/hermes-mcp";
import {
	type CurrentCliInvocation,
	resolveCurrentCliInvocation,
} from "../lib/current-cli-invocation";
import { errMessage } from "../lib/errors";
import { compareSemver, isValidSemver } from "../lib/semver";
import { ensureCodexMcpServer, removeCodexMcpServer } from "./codex-mcp-config";
import { getCodexHome } from "./paths";
import { readCommandVersion } from "./version";

const MCP_COMMAND_TIMEOUT_MS = 15_000;

function commandTimedOut(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && error.code === "ETIMEDOUT"
	);
}

export interface McpLifecycle {
	register(): Promise<boolean>;
	unregister(): Promise<void>;
}

type CommandArgv = readonly [command: string, ...args: string[]];
type CommandSpec = CommandArgv | ((invocation: CurrentCliInvocation) => CommandArgv);

function resolveCommand(spec: CommandSpec, invocation: CurrentCliInvocation): CommandArgv {
	return typeof spec === "function" ? spec(invocation) : spec;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function invocationCommand(invocation: CurrentCliInvocation): string {
	return [invocation.command, ...invocation.args].map(shellQuote).join(" ");
}

function stdioMcpConfig(invocation: CurrentCliInvocation): string {
	return JSON.stringify({ type: "stdio", command: invocation.command, args: invocation.args });
}

function openClawMcpConfig(invocation: CurrentCliInvocation): string {
	return JSON.stringify({ command: invocation.command, args: invocation.args });
}

function commandOnPath(command: string): boolean {
	const extensions =
		process.platform === "win32"
			? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
			: [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			try {
				accessSync(join(directory, `${command}${extension}`), constants.X_OK);
				return true;
			} catch {
				// Continue searching the remaining PATH entries.
			}
		}
	}
	return false;
}

/** Resolve Claude Code's documented native-installer launcher when PATH is incomplete. */
export function claudeExecutable(): string {
	if (commandOnPath("claude")) return "claude";
	const launcher = join(process.env.HOME?.trim() || homedir(), ".local", "bin", "claude");
	return existsSync(launcher) ? launcher : "claude";
}

function commandLifecycle(input: {
	label: string;
	listCommand?: CommandSpec;
	registeredPattern?: RegExp;
	isRegistered?: (listed: string) => boolean;
	isSupported?: () => boolean;
	registerCommand: (invocation: CurrentCliInvocation) => CommandArgv;
	unregisterCommand: CommandSpec;
	manualRegister: (invocation: CurrentCliInvocation) => string;
	manualUnregister?: (invocation: CurrentCliInvocation) => string;
	fallbackRegister?: (invocation: CurrentCliInvocation) => boolean;
	fallbackUnregister?: (invocation: CurrentCliInvocation) => boolean;
	registeredMessage: string;
	fallbackRegisteredMessage?: string;
}): McpLifecycle {
	return {
		async register() {
			const invocation = resolveCurrentCliInvocation(["mcp"]);
			const manualRegister = input.manualRegister(invocation);
			const reportTimeout = () => {
				console.error(chalk.yellow(`⚠ MCP registration in ${input.label} timed out.`));
				console.error(chalk.gray(`  Run manually: ${manualRegister}`));
			};
			if (input.isSupported && !input.isSupported()) {
				console.error(chalk.yellow(`⚠ Could not auto-register MCP server in ${input.label}.`));
				console.error(chalk.gray(`  Run manually: ${manualRegister}`));
				return false;
			}
			if (input.listCommand && (input.registeredPattern || input.isRegistered)) {
				try {
					const [command, ...args] = resolveCommand(input.listCommand, invocation);
					const listed = execFileSync(command, args, {
						stdio: ["ignore", "pipe", "pipe"],
						env: process.env,
						encoding: "utf8",
						timeout: MCP_COMMAND_TIMEOUT_MS,
						killSignal: "SIGKILL",
					});
					if (input.isRegistered?.(listed) || input.registeredPattern?.test(listed)) {
						console.log(chalk.gray(`✓ MCP server already registered in ${input.label}`));
						return true;
					}
				} catch (error) {
					if (commandTimedOut(error)) {
						reportTimeout();
						return false;
					}
					// A failed probe is not evidence that registration cannot work.
				}
			}
			try {
				const [command, ...args] = input.registerCommand(invocation);
				execFileSync(command, args, {
					stdio: "pipe",
					env: process.env,
					timeout: MCP_COMMAND_TIMEOUT_MS,
					killSignal: "SIGKILL",
				});
				console.log(chalk.green(input.registeredMessage));
				return true;
			} catch (error) {
				if (commandTimedOut(error)) {
					reportTimeout();
					return false;
				}
				try {
					if (input.fallbackRegister?.(invocation)) {
						console.log(chalk.green(input.fallbackRegisteredMessage ?? input.registeredMessage));
						return true;
					}
				} catch {
					// Fall through to the manual command when the fallback cannot write safely.
				}
				console.error(chalk.yellow(`⚠ Could not auto-register MCP server in ${input.label}.`));
				console.error(chalk.gray(`  Run manually: ${manualRegister}`));
				return false;
			}
		},
		async unregister() {
			if (input.isSupported && !input.isSupported()) {
				console.log(chalk.gray(`${input.label}: MCP server removal not supported`));
				return;
			}
			const invocation = resolveCurrentCliInvocation(["mcp"]);
			try {
				const [command, ...args] = resolveCommand(input.unregisterCommand, invocation);
				execFileSync(command, args, { stdio: "pipe", env: process.env });
				console.log(chalk.green(`${input.label}: removed MCP server registration`));
			} catch {
				try {
					if (input.fallbackUnregister?.(invocation)) {
						console.log(chalk.green(`${input.label}: removed MCP server registration`));
						return;
					}
				} catch {
					// Fall through to the usual absent/manual hint.
				}
				console.log(
					chalk.gray(`${input.label}: MCP server already absent (or removal not supported)`),
				);
				if (input.manualUnregister) {
					console.log(chalk.gray(`  Remove manually: ${input.manualUnregister(invocation)}`));
				}
			}
		},
	};
}

export const claudeMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "Claude Code",
	listCommand: () => [claudeExecutable(), "mcp", "list"],
	registeredPattern: /^\s*clawdi:\s/m,
	registerCommand: (invocation) => [
		claudeExecutable(),
		"mcp",
		"add-json",
		"clawdi",
		stdioMcpConfig(invocation),
		"--scope",
		"user",
	],
	unregisterCommand: () => [claudeExecutable(), "mcp", "remove", "clawdi"],
	manualRegister: (invocation) =>
		`claude mcp add-json clawdi ${shellQuote(stdioMcpConfig(invocation))} --scope user`,
	registeredMessage: "✓ MCP server registered in Claude Code",
});

export const codexMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "Codex",
	listCommand: ["codex", "mcp", "list"],
	registeredPattern: /^\s*clawdi\b/m,
	registerCommand: (invocation) => [
		"codex",
		"mcp",
		"add",
		"clawdi",
		"--",
		invocation.command,
		...invocation.args,
	],
	unregisterCommand: ["codex", "mcp", "remove", "clawdi"],
	manualRegister: (invocation) => `codex mcp add clawdi -- ${invocationCommand(invocation)}`,
	manualUnregister: () => "remove [mcp_servers.clawdi] from $CODEX_HOME/config.toml",
	fallbackRegister: (invocation) => {
		const codexHome = getCodexHome();
		if (!existsSync(codexHome)) return false;
		ensureCodexMcpServer(join(codexHome, "config.toml"), invocation);
		return true;
	},
	fallbackUnregister: (invocation) =>
		removeCodexMcpServer(join(getCodexHome(), "config.toml"), invocation),
	registeredMessage: "✓ MCP server registered in Codex",
	fallbackRegisteredMessage: "✓ MCP server registered in Codex (config.toml)",
});

export const piMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "Pi",
	isSupported: () => {
		const version = readCommandVersion("pi", ["--version"]);
		return version !== null && isValidSemver(version) && compareSemver(version, "0.99.0") >= 0;
	},
	listCommand: ["pi", "mcp", "list", "--json"],
	isRegistered: (listed) => {
		const report: unknown = JSON.parse(listed);
		if (!report || typeof report !== "object" || !("servers" in report)) return false;
		return (
			Array.isArray(report.servers) &&
			report.servers.some(
				(server: unknown) =>
					server !== null &&
					typeof server === "object" &&
					"name" in server &&
					server.name === "clawdi" &&
					"scope" in server &&
					server.scope === "global" &&
					"transport" in server &&
					server.transport === "clawdi mcp" &&
					"enabled" in server &&
					server.enabled === true,
			)
		);
	},
	registerCommand: (invocation) => [
		"pi",
		"mcp",
		"add",
		"clawdi",
		"--",
		invocation.command,
		...invocation.args,
	],
	unregisterCommand: ["pi", "mcp", "remove", "clawdi"],
	manualRegister: (invocation) =>
		`pi mcp add clawdi -- ${invocationCommand(invocation)} (requires Pi >= 0.99.0)`,
	registeredMessage: "✓ MCP server registered in Pi",
});

export const openClawMcpLifecycle: McpLifecycle = commandLifecycle({
	label: "OpenClaw",
	registerCommand: (invocation) => [
		"openclaw",
		"mcp",
		"set",
		"clawdi",
		openClawMcpConfig(invocation),
	],
	unregisterCommand: ["openclaw", "mcp", "unset", "clawdi"],
	manualRegister: (invocation) =>
		`openclaw mcp set clawdi ${shellQuote(openClawMcpConfig(invocation))}`,
	registeredMessage: "✓ MCP server registered in OpenClaw",
});

export const hermesMcpLifecycle: McpLifecycle = {
	async register() {
		try {
			if (!(await reconcileAllLocalHermesMcp(true))) {
				console.log(chalk.gray("✓ MCP server already registered in Hermes"));
				return true;
			}
			console.log(chalk.green("✓ MCP server registered in Hermes"));
			return true;
		} catch (error) {
			console.error(
				chalk.yellow(`⚠ Could not register MCP server in Hermes: ${errMessage(error)}`),
			);
			console.error(chalk.gray("  Check with: hermes config get mcp_servers --json"));
			return false;
		}
	},
	async unregister() {
		try {
			if (await reconcileAllLocalHermesMcp(false)) {
				console.log(chalk.green("Hermes: removed MCP server registration"));
			} else {
				console.log(chalk.gray("Hermes: MCP server already absent"));
			}
		} catch (error) {
			console.error(
				chalk.yellow(`Hermes: could not remove MCP server registration (${errMessage(error)})`),
			);
			console.error(chalk.gray("  Check with: hermes config get mcp_servers --json"));
		}
	},
};
