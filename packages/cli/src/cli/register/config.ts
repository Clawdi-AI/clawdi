import type { Command } from "commander";

export function registerConfig(program: Command): void {
	const configCmd = program
		.command("config")
		.description("Read or write CLI configuration (~/.clawdi/config.json)");

	configCmd
		.command("list")
		.description("Show effective values and their sources")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { configList } = await import("../../commands/config.js");
			configList(opts);
		});

	configCmd
		.command("paths")
		.description("Show local and hosted runtime paths used by the CLI")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { configPaths } = await import("../../commands/config.js");
			configPaths(opts);
		});

	configCmd
		.command("get <key>")
		.description("Print the effective value for a key")
		.action(async (key) => {
			const { configGet } = await import("../../commands/config.js");
			configGet(key);
		});

	configCmd
		.command("set <key> <value>")
		.description("Persist a config value to disk")
		.action(async (key, value) => {
			const { configSet } = await import("../../commands/config.js");
			configSet(key, value);
		});

	configCmd
		.command("unset <key>")
		.description("Remove a config key from disk")
		.action(async (key) => {
			const { configUnset } = await import("../../commands/config.js");
			configUnset(key);
		});
}
