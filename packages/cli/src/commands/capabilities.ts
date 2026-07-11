import chalk from "chalk";
import { getCliVersion } from "../lib/version";
import { normalizeDeniedCommands, readHostPolicy } from "../runtime/host-policy";
import { detectRuntimeMode } from "../runtime/paths";

interface Capabilities {
	schemaVersion: "clawdi.capabilities.v1";
	cliVersion: string;
	fullCliSurface: true;
	runtimeMode: "local" | "hosted";
	updateMode: "local-self-update" | "system-managed-npm";
	commands: string[];
	restrictedByHostedPolicy: Array<{ command: string; reason?: string }>;
	hostPolicy: {
		source: "builtin" | "file";
		path?: string;
		exists: boolean;
		valid: boolean;
		error?: string;
	};
	mcp: { available: true; command: "clawdi mcp" };
	daemon: { available: true; command: "clawdi daemon run" };
	providerApply: { available: true; command: "clawdi ai-provider apply" };
}

const COMMANDS = [
	"auth",
	"status",
	"config",
	"setup",
	"teardown",
	"push",
	"pull",
	"daemon",
	"serve",
	"ai-provider",
	"vault",
	"read",
	"inject",
	"skill",
	"session",
	"memory",
	"doctor",
	"update",
	"mcp",
	"run",
	"project",
	"agent",
	"inbox",
	"runtime",
	"capabilities",
];

function buildCapabilities(): Capabilities {
	const runtimeMode = detectRuntimeMode();
	const hostPolicy = readHostPolicy();
	const cliUpdateMode = hostPolicy.policy?.cliUpdateMode;
	const updateMode =
		runtimeMode === "hosted" || cliUpdateMode === "system-managed-npm"
			? "system-managed-npm"
			: "local-self-update";

	return {
		schemaVersion: "clawdi.capabilities.v1",
		cliVersion: getCliVersion(),
		fullCliSurface: true,
		runtimeMode,
		updateMode,
		commands: COMMANDS,
		restrictedByHostedPolicy: normalizeDeniedCommands(hostPolicy.policy),
		hostPolicy: {
			source: hostPolicy.source,
			...(hostPolicy.path ? { path: hostPolicy.path } : {}),
			exists: hostPolicy.exists,
			valid: hostPolicy.valid,
			error: hostPolicy.error,
		},
		mcp: { available: true, command: "clawdi mcp" },
		daemon: { available: true, command: "clawdi daemon run" },
		providerApply: { available: true, command: "clawdi ai-provider apply" },
	};
}

export async function capabilitiesCommand(opts: { json?: boolean } = {}) {
	const capabilities = buildCapabilities();
	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(capabilities, null, 2));
		return;
	}

	console.log(chalk.bold("clawdi capabilities"));
	console.log();
	console.log(`  CLI version: ${capabilities.cliVersion}`);
	console.log(`  Runtime mode: ${capabilities.runtimeMode}`);
	console.log(`  Update mode: ${capabilities.updateMode}`);
	console.log(`  Full CLI surface: yes`);
	if (capabilities.restrictedByHostedPolicy.length > 0) {
		console.log();
		console.log(chalk.bold("  Hosted policy restrictions:"));
		for (const entry of capabilities.restrictedByHostedPolicy) {
			const reason = entry.reason ? chalk.gray(` — ${entry.reason}`) : "";
			console.log(`    ${entry.command}${reason}`);
		}
	}
}
