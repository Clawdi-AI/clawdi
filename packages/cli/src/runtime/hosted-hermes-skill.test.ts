import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
import { tarSkillDir } from "../lib/tar";
import type { PreparedHostedCatalogSkill } from "./hosted-catalog-skill-archive";
import { hostedHermesSkillNativeReconciler } from "./hosted-hermes-skill";

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
	mkdirSync(dirname(python), { recursive: true });
	symlinkSync("/usr/bin/python3", python);
	mkdirSync(join(appRoot, "tools"), { recursive: true });
	writeFileSync(join(appRoot, "tools", "__init__.py"), "");
	writeFileSync(join(appRoot, "tools", "skills_hub.py"), FAKE_SKILLS_HUB);
	writeFileSync(join(appRoot, "tools", "skills_guard.py"), FAKE_SKILLS_GUARD);
	return appRoot;
}

describe("Hermes native Workspace Skill integration", () => {
	test("requires paired ownership and uses Hermes install and uninstall semantics", async () => {
		root = mkdtempSync(join(tmpdir(), "hosted-hermes-skill-"));
		delete process.env.CLAWDI_RUNTIME_USER;
		process.env.HERMES_HOME = join(root, "wrong-profile");
		const home = join(root, "home");
		const appRoot = fakeHermesApp(home);
		const sourceDir = join(root, "source", "review-pr");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
		const source = {
			type: "github" as const,
			repoUrl: "https://github.com/Clawdi-AI/store",
			repoSubdir: "skills/review-pr",
			revision: "a".repeat(40),
		};
		const skill: PreparedHostedCatalogSkill = {
			skillId: "review-pr",
			version: 2,
			source,
			digest: "b".repeat(64),
			tarBytes: await tarSkillDir(sourceDir),
		};
		const input = {
			home,
			appRoot,
			skill,
		};

		expect(hostedHermesSkillNativeReconciler.install({ ...input, previouslyReserved: false })).toBe(
			"installed",
		);
		const target = join(home, ".hermes", "skills", "review-pr");
		const lockPath = join(home, ".hermes", "skills", ".hub", "lock.json");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		expect(lock.installed["review-pr"]).toMatchObject({
			install_path: "review-pr",
			metadata: {
				clawdi_manager: "hosted-manifest",
				clawdi_archive_sha256: skill.digest,
				clawdi_source: source,
			},
		});
		expect(hostedHermesSkillNativeReconciler.verifyOwned(input)).toBe(true);

		writeFileSync(join(target, "SKILL.md"), "forged user bytes\n");
		const forgedLock = JSON.parse(readFileSync(lockPath, "utf8"));
		forgedLock.installed["review-pr"].content_hash = `sha256:${createHash("sha256")
			.update("SKILL.md")
			.update("\0")
			.update("forged user bytes\n")
			.digest("hex")
			.slice(0, 16)}`;
		writeFileSync(lockPath, JSON.stringify(forgedLock));
		expect(hostedHermesSkillNativeReconciler.verifyOwned(input)).toBe(false);
		writeFileSync(join(target, "SKILL.md"), "# Review PR\n");
		writeFileSync(lockPath, JSON.stringify(lock));
		expect(hostedHermesSkillNativeReconciler.verifyOwned(input)).toBe(true);
		expect(existsSync(join(root, "wrong-profile", "skills", "review-pr"))).toBe(false);

		expect(() =>
			hostedHermesSkillNativeReconciler.install({ ...input, previouslyReserved: false }),
		).toThrow("not paired with a manifest reservation");
		expect(hostedHermesSkillNativeReconciler.install({ ...input, previouslyReserved: true })).toBe(
			"unchanged",
		);
		expect(
			hostedHermesSkillNativeReconciler.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
			}),
		).toBe("removed");
		expect(existsSync(target)).toBe(false);

		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "user-owned\n");
		expect(() =>
			hostedHermesSkillNativeReconciler.uninstall({
				home,
				appRoot,
				skillId: "review-pr",
			}),
		).toThrow("without a manifest-owned Hub lock");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user-owned\n");
	});
});
