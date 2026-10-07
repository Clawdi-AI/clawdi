import { Command } from "commander";
import { serializeCommandTree } from "../../src/test-support/command-tree";

// Capture the actual CLI program at the parse boundary in a disposable process.
// Do not maintain a second registration tree or execute any command action.
Command.prototype.parseAsync = async function () {
	process.stdout.write(serializeCommandTree(this));
	return this;
};

await import("../../src/index");
