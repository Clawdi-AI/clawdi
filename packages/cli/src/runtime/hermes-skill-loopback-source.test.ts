import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hermesUrlSourceFiles,
	withHermesSkillLoopbackSource,
} from "./hermes-skill-loopback-source";
import { ManagedSkillResourceError } from "./managed-skill-delivery";

let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function fetchProbe(url: string): Array<{ status: number; body: string }> {
	const script = `
const base = process.argv[1];
const requests = [
  fetch(base),
  fetch(new URL("references/guide.md", base)),
  fetch(new URL("unreferenced.txt", base)),
  fetch(new URL("scripts/missing.py", base)),
  fetch(base, { method: "POST" }),
  new Promise((resolve, reject) => {
    const target = new URL(base);
    const path = target.pathname.replace("/SKILL.md", "/references/%2e%2e/SKILL.md");
    const request = process.getBuiltinModule("node:http").get({
      hostname: target.hostname,
      port: target.port,
      path,
    }, response => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, body: "" }));
    });
    request.on("error", reject);
  }),
];
const responses = await Promise.all(requests);
process.stdout.write(JSON.stringify(await Promise.all(responses.map(async response => (
  "text" in response
    ? { status: response.status, body: await response.text() }
    : response
)))));
`;
	const result = spawnSync(process.execPath, ["-e", script, url], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (result.status !== 0) throw new Error(result.stderr || "loopback fetch probe failed");
	return JSON.parse(result.stdout) as Array<{ status: number; body: string }>;
}

test("serves every safe archive file and leaves missing references to Hermes", () => {
	root = mkdtempSync(join(tmpdir(), "hermes-skill-loopback-source-"));
	mkdirSync(join(root, "references"));
	writeFileSync(
		join(root, "SKILL.md"),
		"# Test\n\n[Guide](references/guide.md)\n[Missing](scripts/missing.py)\n",
	);
	writeFileSync(join(root, "references", "guide.md"), "verified guide\n");
	writeFileSync(join(root, "unreferenced.txt"), "archive content\n");
	let url = "";

	withHermesSkillLoopbackSource(root, (source) => {
		url = source.url;
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/0[a-f0-9]{64}\/SKILL\.md$/);
		expect([...source.files.keys()]).toEqual([
			"references/guide.md",
			"SKILL.md",
			"unreferenced.txt",
		]);
		expect(fetchProbe(url)).toEqual([
			{
				status: 200,
				body: "# Test\n\n[Guide](references/guide.md)\n[Missing](scripts/missing.py)\n",
			},
			{ status: 200, body: "verified guide\n" },
			{ status: 200, body: "archive content\n" },
			{ status: 404, body: "" },
			{ status: 405, body: "" },
			{ status: 400, body: "" },
		]);
	});

	const closed = spawnSync(
		process.execPath,
		[
			"-e",
			"try { await fetch(process.argv[1], { signal: AbortSignal.timeout(1000) }); process.exit(1); } catch { process.stdout.write('closed'); }",
			url,
		],
		{ encoding: "utf8", timeout: 2_000 },
	);
	expect(closed.status).toBe(0);
	expect(closed.stdout).toBe("closed");
});

test("validates only the staged archive tree and URL path safety", () => {
	root = mkdtempSync(join(tmpdir(), "hermes-skill-loopback-validation-"));
	expect(() => hermesUrlSourceFiles(root)).toThrow(ManagedSkillResourceError);
	expect(() => hermesUrlSourceFiles(root)).toThrow("prepared Hermes Skill is missing SKILL.md");
	writeFileSync(join(root, "SKILL.md"), Buffer.from([0xff]));
	expect(hermesUrlSourceFiles(root).get("SKILL.md")).toEqual(Buffer.from([0xff]));
	writeFileSync(join(root, "bad:name"), "unsafe URL path\n");
	expect(() => hermesUrlSourceFiles(root)).toThrow(ManagedSkillResourceError);
	expect(() => hermesUrlSourceFiles(root)).toThrow(
		"prepared Hermes Skill path is unsafe: bad:name",
	);
});
