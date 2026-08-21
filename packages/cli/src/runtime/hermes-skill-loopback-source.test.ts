import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hermesUrlSourceFiles,
	withHermesSkillLoopbackSource,
} from "./hermes-skill-loopback-source";

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

test("serves only the nonce-scoped Hermes URL projection and closes synchronously", () => {
	root = mkdtempSync(join(tmpdir(), "hermes-skill-loopback-source-"));
	mkdirSync(join(root, "references"));
	writeFileSync(join(root, "SKILL.md"), "# Test\n\n[Guide](references/guide.md)\n");
	writeFileSync(join(root, "references", "guide.md"), "verified guide\n");
	writeFileSync(join(root, "unreferenced.txt"), "not served\n");
	let url = "";

	withHermesSkillLoopbackSource(root, (source) => {
		url = source.url;
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/0[a-f0-9]{64}\/SKILL\.md$/);
		expect([...source.files.keys()]).toEqual(["SKILL.md", "references/guide.md"]);
		expect(fetchProbe(url)).toEqual([
			{ status: 200, body: "# Test\n\n[Guide](references/guide.md)\n" },
			{ status: 200, body: "verified guide\n" },
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

test("rejects source bytes that Hermes URL installation cannot preserve safely", () => {
	root = mkdtempSync(join(tmpdir(), "hermes-skill-loopback-validation-"));
	writeFileSync(join(root, "SKILL.md"), "[Missing](references/missing.md)\n");
	expect(() => hermesUrlSourceFiles(root)).toThrow(
		"prepared Hermes Skill support file is missing: references/missing.md",
	);
	writeFileSync(join(root, "SKILL.md"), "[Escape](references/%2e%2e/secret.md)\n");
	expect(() => hermesUrlSourceFiles(root)).toThrow("unsafe support file reference");
	writeFileSync(join(root, "SKILL.md"), Buffer.from([0xff]));
	expect(() => hermesUrlSourceFiles(root)).toThrow("SKILL.md is not valid UTF-8");
});
