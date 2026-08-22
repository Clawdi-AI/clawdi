import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import { managedSkillReceiptPath } from "./managed-skill-delivery";

let root: string | null = null;

afterEach(() => {
	delete process.env.CLAWDI_RUNTIME_USER;
	if (root) rmSync(root, { recursive: true, force: true });
	root = null;
});

function preparedArchive(
	archive: string,
): Pick<PreparedHostedSourcedSkill, "archiveSha256" | "tarBytes"> {
	const tarBytes = readFileSync(archive);
	return {
		archiveSha256: createHash("sha256").update(tarBytes).digest("hex"),
		tarBytes,
	};
}

function archiveSkill(
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
	const archive = join(fixtureRoot, `${skillId}${suffix}.tar.gz`);
	const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), skillId]);
	if (packed.status !== 0) throw new Error("test tar creation failed");
	return archive;
}

function sourcedSkill(
	skillId: string,
	archive: string,
	revision = "a".repeat(40),
): PreparedHostedSourcedSkill {
	return {
		skillId,
		source: {
			type: "github",
			url: "https://github.com/Clawdi-AI/store",
			path: `skills/${skillId}`,
			commit: revision,
		},
		sourceIdentity: [
			"github",
			skillId,
			"https://github.com/Clawdi-AI/store",
			`skills/${skillId}`,
			revision,
		].join("\0"),
		...preparedArchive(archive),
	};
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

describe("Hermes exact-source Workspace Skill driver", () => {
	test("places a hub-blocked dangerous source on the official local discovery surface", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-dangerous-local-"));
		const home = join(root, "home");
		const managedResourceRoot = join(root, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
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
		const archive = archiveSkill(root, skillId, dangerousFiles);
		const skill = sourcedSkill(skillId, archive);
		const target = join(home, ".hermes", "skills", skillId);

		expect(fakeHubInstallVerdict(dangerousFiles, true)).toEqual({
			status: "BLOCKED",
			detail:
				"Blocked (community source + dangerous verdict, 3 findings). --force does not override a dangerous verdict.",
		});
		expect(hostedHermesSkillExactSourceDriver.target?.({ home, skill })).toBe(target);
		expect(
			hostedHermesSkillExactSourceDriver.install({
				home,
				managedResourceRoot,
				skill,
				previouslyReserved: false,
			}),
		).toBe("installed");
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
		expect(
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				managedResourceRoot,
				skillId,
				ownershipIdentity: skill.sourceIdentity,
			}),
		).toBe("removed");
		expect(existsSync(target)).toBe(false);
		expect(fakeHermesLocalSkills(home)).toEqual([]);
	});

	test("repairs receipt and byte drift and atomically replaces an owned source", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-local-repair-"));
		const home = join(root, "home");
		const managedResourceRoot = join(root, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
		const skillId = "review-pr";
		const skillV1 = "---\nname: native-review-pr\n---\n# Review PR v1\n";
		const skillV2 = "---\nname: native-review-pr\n---\n# Review PR v2\n";
		const archiveV1 = archiveSkill(root, skillId, { "SKILL.md": skillV1 });
		const archiveV2 = archiveSkill(root, skillId, { "SKILL.md": skillV2 }, "-v2");
		const skill = sourcedSkill(skillId, archiveV1);
		const updatedSkill = sourcedSkill(skillId, archiveV2, "b".repeat(40));
		const target = join(home, ".hermes", "skills", skillId);
		const receipt = managedSkillReceiptPath(managedResourceRoot, "hermes", skillId);
		const input = {
			home,
			managedResourceRoot,
			skill,
		};

		expect(
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toBe("installed");
		const stableInode = statSync(target).ino;
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"unchanged",
		);
		expect(statSync(target).ino).toBe(stableInode);

		rmSync(receipt);
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"installed",
		);
		writeFileSync(join(target, "SKILL.md"), "tenant drift\n");
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(false);
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"installed",
		);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV1);

		expect(
			hostedHermesSkillExactSourceDriver.install({
				...input,
				skill: updatedSkill,
				previouslyReserved: true,
			}),
		).toBe("installed");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV2);
		expect(
			hostedHermesSkillExactSourceDriver.hasOwnershipReceipt({
				home,
				managedResourceRoot,
				skillId,
				ownershipIdentity: updatedSkill.sourceIdentity,
			}),
		).toBe(true);
	});

	test("ignores retired loopback hub metadata for a receipt-owned local Skill", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-loopback-metadata-"));
		const home = join(root, "home");
		const managedResourceRoot = join(root, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
		const skillId = "review-pr";
		const skillFiles = {
			"SKILL.md": "---\nname: review-pr\n---\n# Review PR\n",
			"references/guide.md": "Pinned guide bytes\n",
		};
		const archive = archiveSkill(root, skillId, skillFiles);
		const skill = sourcedSkill(skillId, archive);
		const input = {
			home,
			managedResourceRoot,
			skill,
		};

		expect(
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toBe("installed");
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
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"unchanged",
		);
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

	test("preserves unreserved and locally changed targets", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "hosted-hermes-local-ownership-"));
		root = fixtureRoot;
		const home = join(fixtureRoot, "home");
		const managedResourceRoot = join(fixtureRoot, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
		const skillId = "review-pr";
		const archive = archiveSkill(fixtureRoot, skillId, { "SKILL.md": "# Managed\n" });
		const skill = sourcedSkill(skillId, archive);
		const target = join(home, ".hermes", "skills", skillId);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "user-owned\n");

		expect(() =>
			hostedHermesSkillExactSourceDriver.install({
				home,
				managedResourceRoot,
				skill,
				previouslyReserved: false,
			}),
		).toThrow("not paired with a manifest reservation");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user-owned\n");

		hostedHermesSkillExactSourceDriver.anchorOwnership({
			home,
			managedResourceRoot,
			skillId,
			ownershipIdentity: skill.sourceIdentity,
		});
		writeFileSync(join(target, "SKILL.md"), "changed after receipt\n");
		expect(() =>
			hostedHermesSkillExactSourceDriver.cleanupManifestOwned({
				home,
				managedResourceRoot,
				skillId,
				ownershipIdentity: skill.sourceIdentity,
			}),
		).toThrow("ownership receipt");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("changed after receipt\n");
	});
});
