import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PreparedHostedCatalogSkill } from "./hosted-catalog-skill-archive";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";

const HERMES_MANAGED_SKILL_HELPER = `
import base64
import io
import json
import sys
import tarfile
from pathlib import Path, PurePosixPath

from tools.skills_guard import scan_skill, should_allow_install
from tools.skills_hub import (
    HubLockFile,
    SKILLS_DIR,
    SkillBundle,
    bundle_content_hash,
    content_hash,
    install_from_quarantine,
    quarantine_bundle,
    uninstall_skill,
)

MAX_ENTRIES = 1024
MAX_ENTRY_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MANAGER = "hosted-manifest"


def fail(message):
    print(str(message), file=sys.stderr)
    raise SystemExit(1)


def managed_entry(entry):
    metadata = entry.get("metadata") if isinstance(entry, dict) else None
    return isinstance(metadata, dict) and metadata.get("clawdi_manager") == MANAGER


def locked_entry(lock, skill_id):
    if not lock.path.exists():
        return None
    try:
        data = json.loads(lock.path.read_text())
    except (OSError, json.JSONDecodeError):
        fail("Hermes Skill lock is unreadable")
    installed = data.get("installed") if isinstance(data, dict) else None
    if not isinstance(installed, dict):
        fail("Hermes Skill lock has an invalid installed map")
    entry = installed.get(skill_id)
    if entry is not None and not isinstance(entry, dict):
        fail("Hermes Skill lock entry is invalid")
    return entry


def archive_files(payload):
    skill_id = payload["skillId"]
    prefix = skill_id + "/"
    files = {}
    entry_count = 0
    total_bytes = 0
    raw = base64.b64decode(payload["archiveBase64"], validate=True)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive.getmembers():
            entry_count += 1
            if entry_count > MAX_ENTRIES:
                fail("Skill archive exceeds the Hermes entry limit")
            name = member.name.rstrip("/")
            if name == skill_id and member.isdir():
                continue
            if not name.startswith(prefix):
                fail("Skill archive has an unexpected root")
            relative = name[len(prefix):]
            parts = PurePosixPath(relative).parts
            if not parts or any(part in {"", ".", ".."} for part in parts):
                fail("Skill archive contains an unsafe path")
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                fail("Skill archive contains an unsupported entry")
            if member.size < 0 or member.size > MAX_ENTRY_BYTES:
                fail("Skill archive entry exceeds the Hermes size limit")
            total_bytes += member.size
            if total_bytes > MAX_TOTAL_BYTES:
                fail("Skill archive exceeds the Hermes total size limit")
            if relative in files:
                fail("Skill archive contains a duplicate path")
            source = archive.extractfile(member)
            if source is None:
                fail("Skill archive entry could not be read")
            data = source.read(MAX_ENTRY_BYTES + 1)
            if len(data) != member.size:
                fail("Skill archive entry size does not match its header")
            files[relative] = data
    if "SKILL.md" not in files:
        fail("Skill archive does not contain SKILL.md")
    return files


def install(payload):
    skill_id = payload["skillId"]
    source = payload["source"]
    archive_sha = payload["archiveSha256"]
    previously_reserved = payload.get("previouslyReserved") is True
    lock = HubLockFile()
    existing = locked_entry(lock, skill_id)
    target = SKILLS_DIR / skill_id
    if existing and not managed_entry(existing):
        fail("Hermes Skill lock is owned by a different installer")
    if existing and not previously_reserved:
        fail("Hermes Skill lock is not paired with a manifest reservation")
    if existing and existing.get("install_path") != skill_id:
        fail("Hermes managed Skill lock has an unexpected install path")
    if (target.exists() or target.is_symlink()) and not previously_reserved:
        fail("Hermes Skill target is not paired with a manifest reservation")
    metadata = existing.get("metadata", {}) if existing else {}
    if (
        existing
        and metadata.get("clawdi_archive_sha256") == archive_sha
        and metadata.get("clawdi_source") == source
        and target.is_dir()
        and existing.get("content_hash") == content_hash(target)
    ):
        print(json.dumps({"status": "unchanged"}))
        return

    identifier = source["repoUrl"].removeprefix("https://github.com/") + "/" + source["repoSubdir"]
    bundle = SkillBundle(
        name=skill_id,
        files=archive_files(payload),
        source="github",
        identifier=identifier,
        trust_level="community",
        metadata={
            "clawdi_manager": MANAGER,
            "clawdi_archive_sha256": archive_sha,
            "clawdi_source": source,
        },
    )
    quarantine = quarantine_bundle(bundle)
    result = scan_skill(quarantine, source=identifier)
    allowed, reason = should_allow_install(result, force=False)
    if allowed is not True:
        import shutil
        shutil.rmtree(quarantine, ignore_errors=True)
        fail("Hermes security policy blocked Skill installation: " + reason)
    installed = install_from_quarantine(quarantine, skill_id, "", bundle, result)
    print(json.dumps({"status": "installed", "path": str(installed), "verdict": result.verdict}))


def bounded_live_files(target):
    if target.is_symlink() or not target.is_dir():
        return None
    files = {}
    entry_count = 0
    total_bytes = 0
    try:
        for entry in target.rglob("*"):
            entry_count += 1
            if entry_count > MAX_ENTRIES or entry.is_symlink():
                return None
            if entry.is_dir():
                continue
            if not entry.is_file():
                return None
            size = entry.stat().st_size
            if size < 0 or size > MAX_ENTRY_BYTES:
                return None
            total_bytes += size
            if total_bytes > MAX_TOTAL_BYTES:
                return None
            relative = entry.relative_to(target).as_posix()
            with entry.open("rb") as source:
                data = source.read(MAX_ENTRY_BYTES + 1)
            if len(data) != size:
                return None
            files[relative] = data
    except OSError:
        return None
    return files


def verify_owned(payload):
    skill_id = payload["skillId"]
    source = payload["source"]
    archive_sha = payload["archiveSha256"]
    existing = locked_entry(HubLockFile(), skill_id)
    target = SKILLS_DIR / skill_id
    metadata = existing.get("metadata", {}) if existing else {}
    expected_files = archive_files(payload)
    live_files = bounded_live_files(target)
    live_hash = None
    if live_files is not None:
        live_hash = bundle_content_hash(
            SkillBundle(skill_id, live_files, "github", "verification", "community")
        )
    owned = bool(
        existing
        and managed_entry(existing)
        and existing.get("install_path") == skill_id
        and metadata.get("clawdi_archive_sha256") == archive_sha
        and metadata.get("clawdi_source") == source
        and live_files is not None
        and live_files == expected_files
        and existing.get("content_hash") == live_hash
    )
    print(json.dumps({"status": "owned" if owned else "not_owned"}))


def uninstall(payload):
    skill_id = payload["skillId"]
    lock = HubLockFile()
    existing = locked_entry(lock, skill_id)
    target = SKILLS_DIR / skill_id
    if existing is None:
        if target.exists() or target.is_symlink():
            fail("Hermes Skill exists without a manifest-owned Hub lock")
        print(json.dumps({"status": "absent"}))
        return
    if not managed_entry(existing):
        fail("Hermes Skill lock is owned by a different installer")
    success, message = uninstall_skill(skill_id)
    if not success:
        fail(message)
    print(json.dumps({"status": "removed"}))


try:
    request = json.loads(sys.stdin.read())
    action = request.get("action")
    if action == "install":
        install(request)
    elif action == "verify_owned":
        verify_owned(request)
    elif action == "uninstall":
        uninstall(request)
    else:
        fail("Unsupported managed Skill action")
except SystemExit:
    raise
except Exception as error:
    fail(error)
`;

export interface HostedHermesSkillNativeReconciler {
	install(input: {
		home: string;
		appRoot: string;
		skill: PreparedHostedCatalogSkill;
		previouslyReserved: boolean;
	}): "installed" | "unchanged";
	verifyOwned(input: { home: string; appRoot: string; skill: PreparedHostedCatalogSkill }): boolean;
	uninstall(input: { home: string; appRoot: string; skillId: string }): "absent" | "removed";
}

function runHermesManagedSkillHelper(
	input: {
		home: string;
		appRoot: string;
	},
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const python = join(input.appRoot, "venv", "bin", "python");
	if (!existsSync(input.appRoot) || !executableExists(python)) {
		throw new Error("installed Hermes native Skill integration is unavailable");
	}
	const result = spawnRuntimeUserCommand(
		python,
		["-c", HERMES_MANAGED_SKILL_HELPER],
		input.home,
		input.appRoot,
		{
			hermesHome: join(input.home, ".hermes"),
			input: JSON.stringify(payload),
			maxBufferBytes: 1024 * 1024,
			timeoutMs: 120_000,
		},
	);
	if (result.status !== 0) {
		const detail = String(result.stderr ?? "")
			.trim()
			.split("\n")
			.at(-1);
		throw new Error(`Hermes native Skill reconciliation failed: ${detail || "unknown error"}`);
	}
	try {
		const parsed = JSON.parse(String(result.stdout ?? "{}")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("response is not an object");
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`Hermes native Skill reconciliation returned invalid output: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export const hostedHermesSkillNativeReconciler: HostedHermesSkillNativeReconciler = {
	install(input) {
		const response = runHermesManagedSkillHelper(input, {
			action: "install",
			skillId: input.skill.skillId,
			source: input.skill.source,
			archiveSha256: input.skill.digest,
			archiveBase64: input.skill.tarBytes.toString("base64"),
			previouslyReserved: input.previouslyReserved,
		});
		if (response.status !== "installed" && response.status !== "unchanged") {
			throw new Error("Hermes native Skill install returned an unexpected status");
		}
		return response.status;
	},
	verifyOwned(input) {
		const response = runHermesManagedSkillHelper(input, {
			action: "verify_owned",
			skillId: input.skill.skillId,
			source: input.skill.source,
			archiveSha256: input.skill.digest,
			archiveBase64: input.skill.tarBytes.toString("base64"),
		});
		if (response.status !== "owned" && response.status !== "not_owned") {
			throw new Error("Hermes native Skill ownership verification returned an unexpected status");
		}
		return response.status === "owned";
	},
	uninstall(input) {
		const response = runHermesManagedSkillHelper(input, {
			action: "uninstall",
			skillId: input.skillId,
		});
		if (response.status !== "absent" && response.status !== "removed") {
			throw new Error("Hermes native Skill uninstall returned an unexpected status");
		}
		return response.status;
	},
};
