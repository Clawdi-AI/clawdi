import type { Command } from "commander";
import { parsePositiveInteger } from "../../lib/cli-options.js";

export function registerMemory(program: Command): void {
	const memoryCmd = program.command("memory").description("Manage memories");

	memoryCmd
		.command("list")
		.description("List memories")
		.option("--json", "Output as JSON")
		.option("--limit <n>", "Max number of memories", parsePositiveInteger)
		.option("--category <cat>", "Filter by category (fact/preference/pattern/decision/context)")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi memory list\n  $ clawdi memory list --category preference --json",
		)
		.action(async (opts) => {
			const { memoryList } = await import("../../commands/memory.js");
			await memoryList(opts);
		});

	memoryCmd
		.command("search <query>")
		.description("Search memories by text")
		.option("--json", "Output as JSON")
		.option("--limit <n>", "Max number of memories", parsePositiveInteger)
		.option("--category <cat>", "Filter by category")
		.addHelpText(
			"after",
			'\nExamples:\n  $ clawdi memory search redis\n  $ clawdi memory search "typing styles" --limit 5',
		)
		.action(async (query, opts) => {
			const { memorySearch } = await import("../../commands/memory.js");
			await memorySearch(query, opts);
		});

	memoryCmd
		.command("add <content>")
		.description("Add a memory")
		.option(
			"--category <cat>",
			"One of: fact, preference, pattern, decision, context (default: fact)",
		)
		.addHelpText(
			"after",
			'\nExample:\n  $ clawdi memory add "Prefer concise release notes" --category preference',
		)
		.option("--json", "Output as JSON")
		.action(async (content, opts) => {
			const { memoryAdd } = await import("../../commands/memory.js");
			await memoryAdd(content, opts);
		});

	memoryCmd
		.command("update <id> <content>")
		.description("Replace exact memory content, preserving metadata; use the full ID")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			'\nExample:\n  $ clawdi memory update <memory-id> "Prefer concise release notes" --json',
		)
		.action(async (id, content, opts) => {
			const { memoryUpdate } = await import("../../commands/memory.js");
			await memoryUpdate(id, content, opts);
		});

	memoryCmd
		.command("rm <id>")
		.description("Delete a memory")
		.option("-y, --yes", "Skip the interactive confirmation prompt")
		.addHelpText("after", "\nExample:\n  $ clawdi memory rm <id> --yes")
		.option("--json", "Output as JSON")
		.action(async (id, opts) => {
			const { memoryRm } = await import("../../commands/memory.js");
			await memoryRm(id, opts);
		});
}
