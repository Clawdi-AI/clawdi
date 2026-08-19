import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";

const originalEnv = { ...process.env };
let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	process.env = { ...originalEnv };
});

function fakeHermesApp(home: string): string {
	const appRoot = join(home, ".hermes", "hermes-agent");
	const hermes = join(appRoot, "venv", "bin", "hermes");
	mkdirSync(dirname(hermes), { recursive: true });
	writeFileSync(
		hermes,
		`#!/usr/bin/python3
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ["HOME"]) / ".hermes" / "skills"
with Path(os.environ["FAKE_HERMES_LOG"]).open("a") as log:
    log.write(" ".join(sys.argv[1:]) + chr(10))
if sys.argv[1:3] == ["skills", "install"]:
    assert "--yes" in sys.argv and "--name" in sys.argv
    name = sys.argv[sys.argv.index("--name") + 1]
    if os.environ.get("FAKE_HERMES_INSTALL_BLOCK") == "1":
        print("Installation blocked: Blocked by the native security policy.")
        raise SystemExit(0)
    target = root / name
    marker = root / ".native-installed" / name
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(os.environ["FAKE_HERMES_SOURCE"]) / "SKILL.md", target / "SKILL.md")
    support = Path(os.environ["FAKE_HERMES_SOURCE"]) / "references" / "guide.md"
    if support.exists() and os.environ.get("FAKE_HERMES_OMIT_SUPPORT") != "1":
        (target / "references").mkdir(parents=True, exist_ok=True)
        shutil.copy2(support, target / "references" / "guide.md")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("installed")
elif sys.argv[1:3] == ["skills", "uninstall"]:
    if len(sys.argv) != 4:
        print("hermes skills uninstall: error: unrecognized arguments: " + " ".join(sys.argv[4:]), file=sys.stderr)
        raise SystemExit(2)
    if sys.stdin.readline().strip().lower() not in {"y", "yes"}:
        print("Cancelled.")
        raise SystemExit(0)
    if os.environ.get("FAKE_HERMES_UNINSTALL_FAIL") == "1":
        raise SystemExit(43)
    shutil.rmtree(root / sys.argv[3])
    (root / ".native-installed" / sys.argv[3]).unlink(missing_ok=True)
else:
    raise SystemExit(2)
`,
	);
	chmodSync(hermes, 0o755);
	return appRoot;
}

describe("Hermes exact-source Workspace Skill driver", () => {
	test("rejects a native false success without running a fake rollback", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-project-skill-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		const home = join(root, "home");
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "review-pr");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
		process.env.FAKE_HERMES_SOURCE = sourceDir;
		const commandLog = join(root, "hermes.log");
		process.env.FAKE_HERMES_LOG = commandLog;
		const archive = join(root, "review-pr.tar.gz");
		const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
		if (packed.status !== 0) throw new Error("test tar creation failed");
		const installUrl =
			"https://cloud-api.example.test/v1/runtime/project-skill-files/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/" +
			`${"a".repeat(64)}/${"f".repeat(64)}/SKILL.md`;
		const skill: PreparedHostedSourcedSkill = {
			skillId: "review-pr",
			source: {
				type: "project",
				projectId: "22222222-2222-4222-8222-222222222222",
				contentHash: "a".repeat(64),
				archiveUrl: `https://cloud-api.example.test/v1/runtime/project-skill-archives/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/${"a".repeat(64)}/${"f".repeat(64)}/review-pr.tar.gz`,
				installUrl,
			},
			sourceIdentity: [
				"project",
				"review-pr",
				"22222222-2222-4222-8222-222222222222",
				"a".repeat(64),
			].join("\0"),
			archiveSha256: "b".repeat(64),
			tarBytes: readFileSync(archive),
		};
		process.env.FAKE_HERMES_INSTALL_BLOCK = "1";

		expect(() =>
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				skill,
				previouslyReserved: false,
			}),
		).toThrow(
			"did not preserve the exact native catalog projection: Installation blocked: Blocked by the native security policy.",
		);
		expect(readFileSync(commandLog, "utf8").trim()).toBe(
			`skills install ${installUrl} --name review-pr --yes`,
		);
		expect(existsSync(join(home, ".hermes", "skills", "review-pr"))).toBe(false);
		delete process.env.FAKE_HERMES_INSTALL_BLOCK;
	});

	test("requires paired ownership and uses Hermes install and uninstall semantics", async () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-skill-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		process.env.HERMES_HOME = join(root, "wrong-profile");
		const home = join(root, "home");
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "review-pr");
		mkdirSync(sourceDir, { recursive: true });
		const skillV1 = "# Review PR\n\n[Guide](references/guide.md)\n";
		const skillV2 = "# Review PR v2\n\n[Guide](references/guide.md)\n";
		writeFileSync(join(sourceDir, "SKILL.md"), skillV1);
		mkdirSync(join(sourceDir, "references"), { recursive: true });
		writeFileSync(join(sourceDir, "references", "guide.md"), "Pinned guide\n");
		writeFileSync(join(sourceDir, "skill.json"), '{"catalog_only":true}\n');
		process.env.FAKE_HERMES_SOURCE = sourceDir;
		const commandLog = join(root, "hermes.log");
		process.env.FAKE_HERMES_LOG = commandLog;
		const archive = join(root, "review-pr.tar.gz");
		const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
		if (packed.status !== 0) throw new Error("test tar creation failed");
		const source = {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: "",
			commit: "a".repeat(40),
		};
		const skill: PreparedHostedSourcedSkill = {
			skillId: "review-pr",
			source,
			sourceIdentity: `github\0review-pr\0https://github.com/Clawdi-AI/store\0\0${"a".repeat(40)}`,
			archiveSha256: "b".repeat(64),
			tarBytes: readFileSync(archive),
		};
		const input = {
			home,
			appRoot,
			skill,
		};

		expect(
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toBe("installed");
		const target = join(home, ".hermes", "skills", "review-pr");
		const receipt = join(home, ".hermes", "skills", ".clawdi-manifest-receipts", "review-pr.json");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV1);
		expect(readFileSync(join(target, "references", "guide.md"), "utf8")).toBe("Pinned guide\n");
		expect(existsSync(join(target, "skill.json"))).toBe(false);
		expect(readFileSync(commandLog, "utf8")).not.toContain("--force");
		expect(readFileSync(commandLog, "utf8")).toContain(`/${source.commit}/SKILL.md`);
		expect(readFileSync(commandLog, "utf8")).not.toContain(`/${source.commit}//SKILL.md`);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);
		const receiptBytes = readFileSync(receipt);
		rmSync(receipt);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(false);
		writeFileSync(receipt, receiptBytes);

		writeFileSync(join(target, "SKILL.md"), "forged user bytes\n");
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(false);
		writeFileSync(join(target, "SKILL.md"), skillV1);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);
		expect(existsSync(join(root, "wrong-profile", "skills", "review-pr"))).toBe(false);

		expect(() =>
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toThrow("not paired with a manifest reservation");
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"unchanged",
		);
		writeFileSync(join(sourceDir, "SKILL.md"), skillV2);
		const updateArchive = join(root, "review-pr-update.tar.gz");
		const updatePacked = spawnSync("tar", [
			"-czf",
			updateArchive,
			"-C",
			dirname(sourceDir),
			"review-pr",
		]);
		if (updatePacked.status !== 0) throw new Error("test update tar creation failed");
		const updatedSkill = {
			...skill,
			source: { ...skill.source, path: "skills/review #1%?/nested" },
			sourceIdentity:
				"github\0review-pr\0https://github.com/Clawdi-AI/store\0skills/review-pr\0" +
				"c".repeat(40),
			archiveSha256: "c".repeat(64),
			tarBytes: readFileSync(updateArchive),
		};
		expect(
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				skill: updatedSkill,
				previouslyReserved: true,
			}),
		).toBe("installed");
		expect(readFileSync(commandLog, "utf8").trim().split("\n").at(-1)).toContain("--force");
		expect(readFileSync(commandLog, "utf8").trim().split("\n").at(-1)).toContain(
			"/skills/review%20%231%25%3F/nested/SKILL.md",
		);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV2);
		const wrongSource = join(root, "wrong-source");
		mkdirSync(wrongSource, { recursive: true });
		writeFileSync(join(wrongSource, "SKILL.md"), "wrong bytes\n");
		process.env.FAKE_HERMES_SOURCE = wrongSource;
		const nativeMarker = join(home, ".hermes", "skills", ".native-installed", "review-pr");
		writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR v3\n\n[Guide](references/guide.md)\n");
		const failingArchive = join(root, "review-pr-failing.tar.gz");
		const failingPacked = spawnSync("tar", [
			"-czf",
			failingArchive,
			"-C",
			dirname(sourceDir),
			"review-pr",
		]);
		if (failingPacked.status !== 0) throw new Error("test failing tar creation failed");
		const failingSkill = {
			...updatedSkill,
			sourceIdentity: `${updatedSkill.sourceIdentity}-failure-test`,
			tarBytes: readFileSync(failingArchive),
		};
		expect(() =>
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				skill: failingSkill,
				previouslyReserved: true,
			}),
		).toThrow("did not preserve the exact native catalog projection");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV2);
		expect(
			hostedHermesSkillExactSourceDriver.verifyOwned({ home, appRoot, skill: updatedSkill }),
		).toBe(true);
		expect(existsSync(nativeMarker)).toBe(true);
		writeFileSync(join(sourceDir, "SKILL.md"), skillV2);
		process.env.FAKE_HERMES_SOURCE = sourceDir;
		expect(
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
				ownershipIdentity: updatedSkill.sourceIdentity,
			}),
		).toBe("removed");
		expect(existsSync(target)).toBe(false);
		writeFileSync(receipt, "{}\n");
		expect(
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
				ownershipIdentity: updatedSkill.sourceIdentity,
			}),
		).toBe("absent");
		expect(existsSync(receipt)).toBe(false);
		process.env.FAKE_HERMES_SOURCE = sourceDir;
		process.env.FAKE_HERMES_OMIT_SUPPORT = "1";
		expect(() =>
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				skill: updatedSkill,
				previouslyReserved: true,
			}),
		).toThrow("did not preserve the exact native catalog projection");
		expect(existsSync(receipt)).toBe(false);
		expect(existsSync(target)).toBe(false);
		expect(existsSync(nativeMarker)).toBe(false);
		delete process.env.FAKE_HERMES_OMIT_SUPPORT;
		process.env.FAKE_HERMES_SOURCE = sourceDir;
		expect(
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				skill: updatedSkill,
				previouslyReserved: true,
			}),
		).toBe("installed");
		expect(existsSync(nativeMarker)).toBe(true);
		expect(
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
				ownershipIdentity: updatedSkill.sourceIdentity,
			}),
		).toBe("removed");

		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "user-owned\n");
		expect(() =>
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
				ownershipIdentity: skill.sourceIdentity,
			}),
		).toThrow("ownership receipt");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user-owned\n");
	});
});
