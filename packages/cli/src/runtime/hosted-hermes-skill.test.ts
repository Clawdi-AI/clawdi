import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { ManagedSkillResourceError, managedSkillReceiptPath } from "./managed-skill-delivery";

const originalEnv = { ...process.env };
let root = "";

function preparedArchive(path: string): { archiveSha256: string; tarBytes: Buffer } {
	const tarBytes = readFileSync(path);
	return {
		archiveSha256: createHash("sha256").update(tarBytes).digest("hex"),
		tarBytes,
	};
}

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
import json, os, re, shutil, sys
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse, urlsplit
from urllib.request import urlopen
root = Path(os.environ["HOME"]) / ".hermes" / "skills"
with Path(os.environ["FAKE_HERMES_LOG"]).open("a") as log:
    log.write(" ".join(sys.argv[1:]) + chr(10))
if sys.argv[1:3] == ["skills", "install"]:
    assert "--yes" in sys.argv and "--name" in sys.argv
    assert os.environ.get("HERMES_ALLOW_PRIVATE_URLS") == "true"
    assert "127.0.0.1" in os.environ.get("NO_PROXY", "")
    assert "127.0.0.1" in os.environ.get("no_proxy", "")
    identifier = sys.argv[3]
    name_override = sys.argv[sys.argv.index("--name") + 1]
    if os.environ.get("FAKE_HERMES_INSTALL_NOOP") == "1":
        print("Error: Could not fetch source Skill")
        raise SystemExit(0)
    try:
        source_bytes = urlopen(identifier, timeout=5).read()
        source_text = source_bytes.decode("utf-8")
    except Exception:
        print("Error: Could not fetch source Skill")
        raise SystemExit(0)
    native_name = None
    if source_text.startswith("---"):
        frontmatter_end = source_text.find(chr(10) + "---" + chr(10), 3)
        if frontmatter_end >= 0:
            for line in source_text[3:frontmatter_end].splitlines():
                if line.startswith("name:"):
                    candidate = line.split(":", 1)[1].strip().strip(chr(39) + chr(34))
                    if re.fullmatch(r"[a-z][a-z0-9_-]*", candidate.lower()) and candidate.lower() not in {"skill", "readme", "index", "unnamed-skill"}:
                        native_name = candidate
                    break
    if native_name is None:
        parts = [part for part in urlparse(identifier).path.split("/") if part]
        candidate = parts[-2] if len(parts) >= 2 and parts[-1].lower() == "skill.md" else parts[-1].removesuffix(".md")
        if re.fullmatch(r"[a-z][a-z0-9_-]*", candidate.lower()) and candidate.lower() not in {"skill", "readme", "index", "unnamed-skill"}:
            native_name = candidate
    name = native_name or name_override
    normalized = source_text.replace("\\\\", "/")
    support_paths = set()
    stop_characters = set(" ") | {chr(9), chr(10), chr(13), chr(34), chr(39), chr(41), chr(60), chr(62), chr(96)}
    for directory in ("references", "templates", "scripts", "assets", "examples"):
        marker = directory + "/"
        start = 0
        while True:
            start = normalized.find(marker, start)
            if start < 0:
                break
            end = start
            while end < len(normalized) and normalized[end] not in stop_characters:
                end += 1
            raw = unquote(urlsplit(normalized[start:end].rstrip(".,;:")).path).replace("\\\\", "/")
            parts = [part for part in raw.split("/") if part not in {"", "."}]
            if raw.startswith("/") or not parts or ".." in parts or any(":" in part for part in parts):
                print("Error: Could not fetch source Skill")
                raise SystemExit(0)
            preceded_by_link = normalized[max(0, start - 2):start] == "](" or start == 0 or normalized[start - 1] in stop_characters
            if preceded_by_link:
                support_paths.add("/".join(parts))
            start = end
    support_files = {}
    for path in support_paths:
        try:
            support_files[path] = urlopen(urljoin(identifier, path), timeout=5).read()
        except Exception:
            print("Error: Could not fetch source Skill")
            raise SystemExit(0)
    target = root / name
    marker = root / ".native-installed" / name
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_bytes(source_bytes)
    for path, content in support_files.items():
        destination = target / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("installed")
    hub = root / ".hub"
    lock_path = hub / "lock.json"
    hub.mkdir(parents=True, exist_ok=True)
    lock = json.loads(lock_path.read_text()) if lock_path.exists() else {"version": 1, "installed": {}}
    lock["installed"][name] = {"source": "url", "identifier": identifier, "install_path": name}
    lock_path.write_text(json.dumps(lock, indent=2) + chr(10))
    print("Installed: " + name)
elif sys.argv[1:3] == ["skills", "uninstall"]:
    if len(sys.argv) != 4:
        print("hermes skills uninstall: error: unrecognized arguments: " + " ".join(sys.argv[4:]), file=sys.stderr)
        raise SystemExit(2)
    if sys.stdin.readline().strip().lower() not in {"y", "yes"}:
        print("Cancelled.")
        raise SystemExit(0)
    if os.environ.get("FAKE_HERMES_UNINSTALL_FAIL") == "1":
        raise SystemExit(43)
    name = sys.argv[3]
    shutil.rmtree(root / name)
    (root / ".native-installed" / name).unlink(missing_ok=True)
    lock_path = root / ".hub" / "lock.json"
    lock = json.loads(lock_path.read_text())
    lock["installed"].pop(name, None)
    lock_path.write_text(json.dumps(lock, indent=2) + chr(10))
else:
    raise SystemExit(2)
`,
	);
	chmodSync(hermes, 0o755);
	return appRoot;
}

describe("Hermes exact-source Workspace Skill driver", () => {
	test("rejects a native false success and anchors the official frontmatter target", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-project-skill-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		const home = join(root, "home");
		const managedResourceRoot = join(root, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "review-pr");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(
			join(sourceDir, "SKILL.md"),
			'---\nname: native-review-pr\ndescription: "A long Project Skill description that keeps the native frontmatter name even when --name supplies the manifest id."\n---\n# Review PR\n',
		);
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
			...preparedArchive(archive),
		};
		process.env.FAKE_HERMES_INSTALL_NOOP = "1";

		expect(() =>
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				managedResourceRoot,
				skill,
				previouslyReserved: false,
			}),
		).toThrow("did not record an installed target: Error: Could not fetch source Skill");
		expect(readFileSync(commandLog, "utf8").trim()).toMatch(
			/^skills install http:\/\/127\.0\.0\.1:\d+\/0[a-f0-9]{64}\/SKILL\.md --name review-pr --yes$/,
		);
		expect(existsSync(join(home, ".hermes", "skills", "review-pr"))).toBe(false);
		delete process.env.FAKE_HERMES_INSTALL_NOOP;
		const nativeTarget = hostedHermesSkillExactSourceDriver.target?.({ home, skill });
		expect(nativeTarget).toBe(join(home, ".hermes", "skills", "native-review-pr"));
		expect(
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				managedResourceRoot,
				skill,
				targetDir: nativeTarget,
				previouslyReserved: false,
			}),
		).toBe("installed");
		expect(existsSync(join(home, ".hermes", "skills", "review-pr"))).toBe(false);
		expect(existsSync(nativeTarget ?? "")).toBe(true);
		expect(
			hostedHermesSkillExactSourceDriver.verifyOwned({
				home,
				appRoot,
				managedResourceRoot,
				skill,
				targetDir: nativeTarget,
			}),
		).toBe(true);
	});

	test("lets official Hermes reject a support reference missing from the archive", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-missing-support-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		const home = join(root, "home");
		const managedResourceRoot = join(root, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "missing-support");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(
			join(sourceDir, "SKILL.md"),
			"---\nname: missing-support\n---\n# Missing support\n\n[Sync](scripts/hermes-direct-slack-sync.py)\n",
		);
		writeFileSync(join(sourceDir, "archive-only.txt"), "served but not requested\n");
		const archive = join(root, "missing-support.tar.gz");
		const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "missing-support"]);
		if (packed.status !== 0) throw new Error("test tar creation failed");
		process.env.FAKE_HERMES_LOG = join(root, "hermes.log");
		const skill: PreparedHostedSourcedSkill = {
			skillId: "missing-support",
			source: {
				type: "github",
				url: "https://github.com/Clawdi-AI/store",
				path: "skills/missing-support",
				commit: "a".repeat(40),
			},
			sourceIdentity: `github\0missing-support\0https://github.com/Clawdi-AI/store\0skills/missing-support\0${"a".repeat(40)}`,
			...preparedArchive(archive),
		};
		let failure: unknown;

		try {
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				managedResourceRoot,
				skill,
				previouslyReserved: false,
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ManagedSkillResourceError);
		expect(failure).toHaveProperty(
			"message",
			"Hermes official Skill install did not record an installed target: Error: Could not fetch source Skill",
		);
		expect(existsSync(join(home, ".hermes", "skills", "missing-support"))).toBe(false);
	});

	test("requires paired ownership and uses Hermes install and uninstall semantics", async () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-skill-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		process.env.HERMES_HOME = join(root, "wrong-profile");
		const home = join(root, "home");
		const managedResourceRoot = join(root, "managed-resources");
		mkdirSync(managedResourceRoot, { recursive: true });
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "review-pr");
		mkdirSync(sourceDir, { recursive: true });
		const skillV1 =
			"---\nname: review-pr\ndescription: Review pull requests\n---\n# Review PR\n\n[Guide](references/guide.md)\n";
		const skillV2 =
			"---\nname: review-pr\ndescription: Review pull requests\n---\n# Review PR v2\n\n[Guide](references/guide.md)\n";
		writeFileSync(join(sourceDir, "SKILL.md"), skillV1);
		mkdirSync(join(sourceDir, "references"), { recursive: true });
		writeFileSync(join(sourceDir, "references", "guide.md"), "Pinned guide\n");
		writeFileSync(join(sourceDir, "skill.json"), '{"catalog_only":true}\n');
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
			...preparedArchive(archive),
		};
		const input = {
			home,
			appRoot,
			managedResourceRoot,
			skill,
		};

		expect(
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toBe("installed");
		const target = join(home, ".hermes", "skills", "review-pr");
		const receipt = managedSkillReceiptPath(managedResourceRoot, "hermes", "review-pr");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV1);
		expect(readFileSync(join(target, "references", "guide.md"), "utf8")).toBe("Pinned guide\n");
		expect(existsSync(join(target, "skill.json"))).toBe(false);
		expect(readFileSync(commandLog, "utf8")).not.toContain("--force");
		const firstInstallCommand = readFileSync(commandLog, "utf8").trim();
		expect(firstInstallCommand).toMatch(
			/^skills install http:\/\/127\.0\.0\.1:\d+\/0[a-f0-9]{64}\/SKILL\.md --name review-pr --yes$/,
		);
		const firstInstallUrl = firstInstallCommand.split(" ")[2] ?? "";
		const lockPath = join(home, ".hermes", "skills", ".hub", "lock.json");
		const firstLock = JSON.parse(readFileSync(lockPath, "utf8")) as {
			version: number;
			installed: Record<string, Record<string, unknown>>;
		};
		expect(firstLock.installed["review-pr"]).toEqual({
			source: "url",
			identifier: firstInstallUrl,
			install_path: "review-pr",
		});
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"unchanged",
		);
		expect(readFileSync(commandLog, "utf8").trim().split("\n")).toHaveLength(1);
		firstLock.installed["review-pr"] = {
			source: "url",
			identifier: `https://raw.githubusercontent.com/Clawdi-AI/store/${source.commit}/SKILL.md`,
			install_path: "review-pr",
		};
		writeFileSync(lockPath, `${JSON.stringify(firstLock)}\n`);
		expect(hostedHermesSkillExactSourceDriver.target?.({ home, skill })).toBe(target);
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"installed",
		);
		const migratedLock = JSON.parse(readFileSync(lockPath, "utf8")) as typeof firstLock;
		const migratedIdentifier = migratedLock.installed["review-pr"]?.identifier;
		expect(migratedIdentifier).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/0[a-f0-9]{64}\/SKILL\.md$/);
		migratedLock.installed["review-pr"] = {
			source: "url",
			identifier: "http://127.0.0.1:1234/predictable/SKILL.md",
			install_path: "review-pr",
		};
		writeFileSync(lockPath, `${JSON.stringify(migratedLock)}\n`);
		expect(() => hostedHermesSkillExactSourceDriver.target?.({ home, skill })).toThrow(
			"Hermes Skill lock source is invalid",
		);
		migratedLock.installed["review-pr"] = {
			source: "url",
			identifier: String(migratedIdentifier).replace(/:\d+\//, ":0/"),
			install_path: "review-pr",
		};
		writeFileSync(lockPath, `${JSON.stringify(migratedLock)}\n`);
		expect(() => hostedHermesSkillExactSourceDriver.target?.({ home, skill })).toThrow(
			"Hermes Skill lock source is invalid",
		);
		migratedLock.installed["review-pr"] = {
			source: "url",
			identifier: String(migratedIdentifier).replace("http://127.0.0.1:", "HTTP://127.0.0.1:"),
			install_path: "review-pr",
		};
		writeFileSync(lockPath, `${JSON.stringify(migratedLock)}\n`);
		expect(() => hostedHermesSkillExactSourceDriver.target?.({ home, skill })).toThrow(
			"Hermes Skill lock source is invalid",
		);
		migratedLock.installed["review-pr"] = {
			source: "url",
			identifier: migratedIdentifier,
			install_path: "review-pr",
		};
		migratedLock.installed["duplicate-review-pr"] = {
			source: "url",
			identifier: migratedIdentifier,
			install_path: "duplicate-review-pr",
		};
		writeFileSync(lockPath, `${JSON.stringify(migratedLock)}\n`);
		expect(() => hostedHermesSkillExactSourceDriver.target?.({ home, skill })).toThrow(
			"Hermes Skill lock source identity is ambiguous",
		);
		delete migratedLock.installed["duplicate-review-pr"];
		writeFileSync(lockPath, `${JSON.stringify(migratedLock)}\n`);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);
		expect(
			hostedHermesSkillExactSourceDriver.hasOwnershipReceipt({
				home,
				managedResourceRoot,
				skillId: "review-pr",
				ownershipIdentity: skill.sourceIdentity,
			}),
		).toBe(true);
		expect(
			hostedHermesSkillExactSourceDriver.hasOwnershipReceipt({
				home,
				managedResourceRoot,
				skillId: "review-pr",
				ownershipIdentity: `${skill.sourceIdentity}-other`,
			}),
		).toBe(false);
		rmSync(receipt);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(false);
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"installed",
		);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);

		writeFileSync(join(target, "SKILL.md"), "forged user bytes\n");
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(false);
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"installed",
		);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV1);
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);
		expect(existsSync(join(root, "wrong-profile", "skills", "review-pr"))).toBe(false);

		expect(() =>
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toThrow("not paired with a manifest reservation");
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
			...preparedArchive(updateArchive),
		};
		expect(
			hostedHermesSkillExactSourceDriver.install({
				home,
				appRoot,
				managedResourceRoot,
				skill: updatedSkill,
				previouslyReserved: true,
			}),
		).toBe("installed");
		expect(readFileSync(commandLog, "utf8").trim().split("\n").at(-1)).toContain("--force");
		const updateInstallCommand = readFileSync(commandLog, "utf8").trim().split("\n").at(-1) ?? "";
		expect(updateInstallCommand).toMatch(
			/^skills install http:\/\/127\.0\.0\.1:\d+\/0[a-f0-9]{64}\/SKILL\.md --name review-pr --yes --force$/,
		);
		expect(updateInstallCommand).not.toBe(firstInstallCommand);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillV2);
		expect(
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				managedResourceRoot,
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
				managedResourceRoot,
				skillId: "review-pr",
				ownershipIdentity: updatedSkill.sourceIdentity,
			}),
		).toBe("absent");
		expect(existsSync(receipt)).toBe(false);

		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "user-owned\n");
		expect(() =>
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toThrow("not paired with a manifest reservation");
		expect(() =>
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				managedResourceRoot,
				skillId: "review-pr",
				ownershipIdentity: skill.sourceIdentity,
			}),
		).toThrow("ownership receipt");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user-owned\n");
	});
});
