import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCliVersion } from "../src/lib/version";

async function runFixture(name: string, args: string[] = []) {
	const home = mkdtempSync(join(tmpdir(), "clawdi-command-tree-"));
	try {
		const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures", name), ...args], {
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
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("the complete Commander tree and help match the origin/main baseline", async () => {
	const { stdout, stderr, code } = await runFixture("capture-command-tree.ts");
	expect(code, stderr).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toBe(readFileSync(join(import.meta.dir, "fixtures/command-tree.txt"), "utf8"));
});

test("--version preserves the baseline lazy command imports", async () => {
	const { stdout, stderr, code } = await runFixture("version-import-guard.ts", ["--version"]);
	expect(code, stderr).toBe(0);
	expect(stderr).toBe("");
	expect(stdout.trim()).toBe(getCliVersion());
});
