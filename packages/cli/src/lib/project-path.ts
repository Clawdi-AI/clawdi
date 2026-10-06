import { homedir } from "node:os";
import { resolve } from "node:path";

export function normalizeProject(input: string): string {
	// Expand `~` for shell-less callers; `path.resolve` does not expand it.
	let expanded = input;
	if (expanded === "~") expanded = homedir();
	else if (expanded.startsWith("~/")) expanded = `${homedir()}${expanded.slice(1)}`;
	return resolve(expanded);
}
