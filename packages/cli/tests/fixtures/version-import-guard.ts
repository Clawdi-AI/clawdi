import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { plugin } from "bun";

plugin({
	name: "reject-eager-command-imports",
	setup(build) {
		build.onLoad({ filter: /[/\\]src[/\\]commands[/\\][^/\\]+\.(?:ts|js)$/ }, ({ path }) => {
			// The baseline loads the daemon registrar, Hermes MCP helpers through
			// the adapter registry, and the opportunistic auto-update hook.
			const baseline = [
				"serve-cli.ts",
				"serve-cli.js",
				"hermes-mcp.ts",
				"hermes-mcp.js",
				"update.ts",
				"update.js",
			];
			if (baseline.includes(basename(path))) {
				return { contents: readFileSync(path, "utf8"), loader: path.endsWith(".ts") ? "ts" : "js" };
			}
			throw new Error(`Command implementation loaded during --version: ${basename(path)}`);
		});
	},
});

await import("../../src/index");
