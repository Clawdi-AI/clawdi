import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

it("runs managed WhatsApp gate-on projection evidence in an isolated test process", () => {
	const fixture = join(import.meta.dir, "fixtures", "managed-whatsapp-projection.gated.ts");
	const result = spawnSync(process.execPath, ["test", fixture], {
		encoding: "utf8",
		env: process.env,
	});

	expect(result.error).toBeUndefined();
	if (result.status !== 0) {
		throw new Error(
			`isolated managed WhatsApp projection tests failed (${String(result.status)}):\n${result.stdout}${result.stderr}`,
		);
	}
});
