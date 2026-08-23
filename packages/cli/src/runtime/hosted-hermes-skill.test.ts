import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateHostedHermesSkill } from "./hosted-hermes-skill";

let root: string | null = null;

afterEach(() => {
	delete process.env.CLAWDI_RUNTIME_USER;
	if (root) rmSync(root, { recursive: true, force: true });
	root = null;
});

function writeSkill(
	fixtureRoot: string,
	skillId: string,
	files: Readonly<Record<string, string>>,
	suffix = "",
): string {
	const sourceDir = join(fixtureRoot, `source${suffix}`, skillId);
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(sourceDir, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return sourceDir;
}

function fakeHubInstallVerdict(
	files: Readonly<Record<string, string>>,
	force: boolean,
): { status: "BLOCKED"; detail: string } {
	const content = Object.values(files).join("\n");
	const findings = ["shell=True", "os.environ", "eval("].filter((pattern) =>
		content.includes(pattern),
	);
	if (findings.length !== 3)
		throw new Error("dangerous Hermes fixture no longer matches scan policy");
	return {
		status: "BLOCKED",
		detail: `Blocked (community source + dangerous verdict, ${findings.length} findings).${
			force ? " --force does not override a dangerous verdict." : ""
		}`,
	};
}

function fakeHermesLocalSkills(home: string): Array<{
	name: string;
	source: "local";
	trust: "local";
	status: "enabled";
}> {
	const skillsRoot = join(home, ".hermes", "skills");
	if (!existsSync(skillsRoot)) return [];
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.flatMap((entry) => {
			const skillPath = join(skillsRoot, entry.name, "SKILL.md");
			if (!existsSync(skillPath)) return [];
			const content = readFileSync(skillPath, "utf8");
			const name = /^---\s*\n[\s\S]*?^name:\s*([^\n]+)$/m.exec(content)?.[1]?.trim();
			return [{ name: name || entry.name, source: "local", trust: "local", status: "enabled" }];
		});
}

describe("Hermes exact-source Workspace Skill activation", () => {
	test("places a hub-blocked dangerous source on the official local discovery surface", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-dangerous-local-"));
		const home = join(root, "home");
		const skillId = "dangerous-local";
		const dangerousSkill = `---
name: blocked-page-recovery
description: Recover blocked pages with browser and shell fallbacks
---
# Blocked page recovery

Run \`subprocess.run(..., shell=True)\`, inspect \`os.environ\`, then evaluate the response.
`;
		const dangerousFiles = {
			"SKILL.md": dangerousSkill,
			"references/policy.md": "Verified support file\n",
			"scripts/recover_page.py":
				'import os\nimport subprocess\nsubprocess.run(input(), shell=True)\neval(os.environ["RECOVERY_EXPRESSION"])\n',
			"skill.json": '{"catalog_only":true}\n',
		};
		const sourceDir = writeSkill(root, skillId, dangerousFiles);
		const target = join(home, ".hermes", "skills", skillId);

		expect(fakeHubInstallVerdict(dangerousFiles, true)).toEqual({
			status: "BLOCKED",
			detail:
				"Blocked (community source + dangerous verdict, 3 findings). --force does not override a dangerous verdict.",
		});
		activateHostedHermesSkill(sourceDir, target);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(dangerousSkill);
		expect(readFileSync(join(target, "references", "policy.md"), "utf8")).toBe(
			"Verified support file\n",
		);
		expect(readFileSync(join(target, "skill.json"), "utf8")).toBe('{"catalog_only":true}\n');
		expect(existsSync(join(home, ".hermes", "skills", ".hub", "lock.json"))).toBe(false);
		expect(fakeHermesLocalSkills(home)).toEqual([
			{
				name: "blocked-page-recovery",
				source: "local",
				trust: "local",
				status: "enabled",
			},
		]);

		// A fresh discovery instance models a restarted gateway process.
		expect(fakeHermesLocalSkills(home)).toHaveLength(1);
	});

	test("atomically replaces an exact source", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-local-repair-"));
		const home = join(root, "home");
		const skillId = "review-pr";
		const skillV1 = "---\nname: native-review-pr\n---\n# Review PR v1\n";
		const skillV2 = "---\nname: native-review-pr\n---\n# Review PR v2\n";
		const sourceV1 = writeSkill(root, skillId, { "SKILL.md": skillV1 });
		const sourceV2 = writeSkill(root, skillId, { "SKILL.md": skillV2 }, "-v2");
		const target = join(home, ".hermes", "skills", skillId);

		activateHostedHermesSkill(sourceV1, target);
		writeFileSync(join(target, "SKILL.md"), "tenant drift\n");
		activateHostedHermesSkill(sourceV1, target);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV1);

		activateHostedHermesSkill(sourceV2, target);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV2);
	});

	test("does not modify Hermes hub metadata", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-loopback-metadata-"));
		const home = join(root, "home");
		const skillId = "review-pr";
		const skillFiles = {
			"SKILL.md": "---\nname: review-pr\n---\n# Review PR\n",
			"references/guide.md": "Pinned guide bytes\n",
		};
		const sourceDir = writeSkill(root, skillId, skillFiles);
		const target = join(home, ".hermes", "skills", skillId);

		activateHostedHermesSkill(sourceDir, target);
		const lockPath = join(home, ".hermes", "skills", ".hub", "lock.json");
		mkdirSync(dirname(lockPath), { recursive: true });
		const externalEntry = {
			source: "url",
			identifier: "https://example.test/user-skill/SKILL.md",
			install_path: "user-skill",
		};
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				version: 1,
				installed: {
					[skillId]: {
						source: "url",
						identifier: `http://127.0.0.1:43123/0${"a".repeat(64)}/SKILL.md`,
						install_path: skillId,
					},
					"user-skill": externalEntry,
				},
			})}\n`,
		);
		const lockBefore = readFileSync(lockPath);
		activateHostedHermesSkill(sourceDir, target);
		expect(readFileSync(lockPath)).toEqual(lockBefore);
		expect(JSON.parse(readFileSync(lockPath, "utf8")).installed).toEqual({
			[skillId]: {
				source: "url",
				identifier: `http://127.0.0.1:43123/0${"a".repeat(64)}/SKILL.md`,
				install_path: skillId,
			},
			"user-skill": externalEntry,
		});
	});
});
