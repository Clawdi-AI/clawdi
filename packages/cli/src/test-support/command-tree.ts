import type { Command } from "commander";

/** Capture the registered tree, including hidden surfaces and help epilogs. */
export function serializeCommandTree(program: Command): string {
	const commands: Record<string, unknown>[] = [];

	function visit(command: Command, path: string[]): void {
		let help = "";
		const output = { ...command.configureOutput() };
		command.configureOutput({
			writeOut: (text) => {
				help += text;
			},
			getOutHelpWidth: () => 80,
			getOutHasColors: () => false,
		});
		try {
			command.outputHelp();
		} finally {
			command.configureOutput(output);
		}

		commands.push({
			path: path.join(" "),
			aliases: command.aliases(),
			description: command.description(),
			hidden: Reflect.get(command, "_hidden") === true,
			arguments: command.registeredArguments.map((argument) => ({
				name: argument.name(),
				description: argument.description,
				required: argument.required,
				variadic: argument.variadic,
				default: argument.defaultValue,
				choices: argument.argChoices,
			})),
			options: command.options.map((option) => ({
				flags: option.flags,
				description: option.description,
				hidden: option.hidden,
				required: option.required,
				optional: option.optional,
				mandatory: option.mandatory,
				variadic: option.variadic,
				default: option.defaultValue,
				defaultDescription: option.defaultValueDescription,
				// Commander supplies true for negated flags without an explicit default.
				effectiveDefault: command.getOptionValue(option.attributeName()),
				preset: option.presetArg,
				choices: option.argChoices,
			})),
			help,
		});
		for (const child of command.commands) visit(child, [...path, child.name()]);
	}

	visit(program, [program.name()]);
	return `${JSON.stringify(commands, null, "\t")}\n`;
}
