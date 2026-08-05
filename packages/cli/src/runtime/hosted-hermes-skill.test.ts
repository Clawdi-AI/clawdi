import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreparedHostedCatalogSkill } from "./hosted-catalog-skill-archive";
import { hostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";

const originalEnv = { ...process.env };
let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	process.env = { ...originalEnv };
});

const FAKE_SKILLS_HUB = String.raw`
import hashlib
import json
import os
import shutil
from pathlib import Path

SKILLS_DIR = Path(os.environ["HERMES_HOME"]) / "skills"
LOCK_FILE = SKILLS_DIR / ".hub" / "lock.json"
QUARANTINE_DIR = SKILLS_DIR / ".hub" / "quarantine"

class SkillBundle:
    def __init__(self, name, files, source, identifier, trust_level, metadata=None):
        self.name = name
        self.files = files
        self.source = source
        self.identifier = identifier
        self.trust_level = trust_level
        self.metadata = {} if metadata is None else metadata

def content_hash(path):
    digest = hashlib.sha256()
    for item in sorted(path.rglob("*")):
        if item.is_file():
            digest.update(item.relative_to(path).as_posix().encode())
            digest.update(b"\0")
            digest.update(item.read_bytes())
    return "sha256:" + digest.hexdigest()[:16]

def bundle_content_hash(bundle):
    digest = hashlib.sha256()
    for relative in sorted(bundle.files):
        digest.update(relative.encode())
        digest.update(b"\0")
        content = bundle.files[relative]
        digest.update(content if isinstance(content, bytes) else content.encode())
    return "sha256:" + digest.hexdigest()[:16]

class HubLockFile:
    def __init__(self):
        self.path = LOCK_FILE
    def load(self):
        if not self.path.exists():
            return {"version": 1, "installed": {}}
        return json.loads(self.path.read_text())
    def save(self, value):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(value))
    def get_installed(self, name):
        return self.load()["installed"].get(name)

def quarantine_bundle(bundle):
    target = QUARANTINE_DIR / bundle.name
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    for relative, content in bundle.files.items():
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
    return target

def install_from_quarantine(quarantine, skill_name, category, bundle, result):
    target = SKILLS_DIR / skill_name
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(quarantine), str(target))
    lock = HubLockFile()
    data = lock.load()
    data["installed"][skill_name] = {
        "source": bundle.source,
        "identifier": bundle.identifier,
        "trust_level": bundle.trust_level,
        "scan_verdict": result.verdict,
        "content_hash": content_hash(target),
        "install_path": skill_name,
        "files": list(bundle.files),
        "metadata": bundle.metadata,
    }
    lock.save(data)
    return target

def uninstall_skill(skill_name):
    lock = HubLockFile()
    data = lock.load()
    entry = data["installed"].pop(skill_name, None)
    if entry is None:
        return False, "not installed"
    shutil.rmtree(SKILLS_DIR / entry["install_path"], ignore_errors=True)
    lock.save(data)
    return True, "removed"
`;

const FAKE_SKILLS_GUARD = `
from types import SimpleNamespace

def scan_skill(path, source):
    return SimpleNamespace(verdict="safe")

def should_allow_install(result, force=False):
    return True, "allowed"
`;

function fakeHermesApp(home: string): string {
	const appRoot = join(home, ".hermes", "hermes-agent");
	const python = join(appRoot, "venv", "bin", "python");
	const hermes = join(appRoot, "venv", "bin", "hermes");
	mkdirSync(dirname(python), { recursive: true });
	symlinkSync("/usr/bin/python3", python);
	mkdirSync(join(appRoot, "tools"), { recursive: true });
	writeFileSync(join(appRoot, "tools", "__init__.py"), "");
	writeFileSync(join(appRoot, "tools", "skills_hub.py"), FAKE_SKILLS_HUB);
	writeFileSync(join(appRoot, "tools", "skills_guard.py"), FAKE_SKILLS_GUARD);
	writeFileSync(
		hermes,
		`#!/usr/bin/python3
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ["HERMES_HOME"]) / "skills"
if sys.argv[1:3] == ["skills", "install"]:
    assert sys.argv[-1] == "--yes" and sys.argv[-3] == "--name"
    name = sys.argv[-2]
    target = root / name
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(Path(os.environ["FAKE_HERMES_SOURCE"]), target)
elif sys.argv[1:3] == ["skills", "uninstall"]:
    assert sys.argv[-1] == "--yes"
    shutil.rmtree(root / sys.argv[3])
else:
    raise SystemExit(2)
`,
	);
	chmodSync(hermes, 0o755);
	return appRoot;
}

describe("Hermes exact-source Workspace Skill driver", () => {
	test("requires paired ownership and uses Hermes install and uninstall semantics", async () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-skill-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		process.env.HERMES_HOME = join(root, "wrong-profile");
		const home = join(root, "home");
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "review-pr");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
		process.env.FAKE_HERMES_SOURCE = sourceDir;
		const archive = join(root, "review-pr.tar.gz");
		const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
		if (packed.status !== 0) throw new Error("test tar creation failed");
		const source = {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: "skills/review-pr",
			commit: "a".repeat(40),
		};
		const skill: PreparedHostedCatalogSkill = {
			skillId: "review-pr",
			source,
			digest: "b".repeat(64),
			tarBytes: readFileSync(archive),
		};
		const input = {
			home,
			appRoot,
			skill,
		};

		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false })).toBe(
			"installed",
		);
		const target = join(home, ".hermes", "skills", "review-pr");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);

		writeFileSync(join(target, "SKILL.md"), "forged user bytes\n");
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(false);
		writeFileSync(join(target, "SKILL.md"), "# Review PR\n");
		expect(hostedHermesSkillExactSourceDriver.verifyOwned(input)).toBe(true);
		expect(existsSync(join(root, "wrong-profile", "skills", "review-pr"))).toBe(false);

		expect(() =>
			hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: false }),
		).toThrow("not paired with a manifest reservation");
		expect(hostedHermesSkillExactSourceDriver.install({ ...input, previouslyReserved: true })).toBe(
			"unchanged",
		);
		expect(
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
			}),
		).toBe("removed");
		expect(existsSync(target)).toBe(false);

		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "user-owned\n");
		expect(() =>
			hostedHermesSkillExactSourceDriver.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
			}),
		).toThrow("ownership receipt");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user-owned\n");
	});
});
