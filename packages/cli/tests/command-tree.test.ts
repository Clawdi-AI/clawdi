import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the complete Commander tree and help match the origin/main baseline", async () => {
	const home = mkdtempSync(join(tmpdir(), "clawdi-command-tree-"));
	try {
		const process = Bun.spawn(["bun", join(import.meta.dir, "fixtures/capture-command-tree.ts")], {
			env: {
				...Bun.env,
				HOME: home,
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
				NO_COLOR: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe(readFileSync(join(import.meta.dir, "fixtures/command-tree.txt"), "utf8"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
