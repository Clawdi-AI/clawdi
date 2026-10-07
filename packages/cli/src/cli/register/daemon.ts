import type { Command } from "commander";
import { registerServeCommand } from "../../commands/serve-cli.js";

export function registerDaemon(program: Command): void {
	registerServeCommand(program);
}
