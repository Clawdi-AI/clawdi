import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

it("uses generated clients for Cloud JSON calls", async () => {
	const sourceRoot = join(import.meta.dir, "../src");
	const violations: string[] = [];
	for await (const file of new Bun.Glob("**/*.ts").scan(sourceRoot)) {
		if (file.endsWith(".test.ts")) continue;
		const source = await readFile(join(sourceRoot, file), "utf8");
		if (
			/\bauthedJson\b|\.\s*request\s*(?:<[\s\S]*?>)?\s*\(|\bawait\s+request\s*(?:<[\s\S]*?>)?\s*\(/.test(
				source,
			)
		) {
			violations.push(file);
		}
		// /v1/mcp/clawdi is hidden from OpenAPI. Doctor's existing JSON-RPC
		// ping is the only remaining caller, and the helper accepts only that path.
		if (file !== "lib/api-client.ts") {
			const calls = source.match(/\.postJson(?:Body)?\b/g) ?? [];
			if (
				calls.length &&
				!(
					file === "commands/doctor.ts" &&
					calls.length === 1 &&
					/\.postJsonBody<JsonRpcResponse>\("\/v1\/mcp\/clawdi",/.test(source)
				)
			) {
				violations.push(file);
			}
		}
	}
	expect(violations).toEqual([]);
});
