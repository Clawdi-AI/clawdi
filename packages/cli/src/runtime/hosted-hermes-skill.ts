import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { hostedSkillArchiveSourceIdentity } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	ManagedSkillResourceError,
	managedSkillTargetMatchesSource,
} from "./managed-skill-delivery";
import { replaceManagedSkillDirectoryAtomic } from "./managed-skill-reservation";
import type { HostedSkillSource } from "./manifest-resources";
import { recordValue } from "./manifest-shared";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

// Supply a verified bundle to Hermes' public pipeline. Hermes owns scanning,
// install/uninstall mutations, Hub records and cache invalidation.
const HERMES_SKILL_OPERATION = `
import base64, json, shutil, sys
from tools.skills_hub import (
    SkillBundle, HubLockFile, LOCK_FILE, SKILLS_DIR,
    quarantine_bundle, install_from_quarantine, uninstall_skill,
)
from tools.skills_guard import scan_skill, should_allow_install
from agent.prompt_builder import clear_skills_system_prompt_cache

class NativeStateError(Exception):
    pass

target_mutation_started = False

def checked_lock():
    # Native load() treats unreadable or torn JSON as an empty lock. Never let
    # a subsequent native save silently erase sibling installations that way.
    if LOCK_FILE.parent.is_symlink() or LOCK_FILE.is_symlink():
        raise NativeStateError("Hermes Hub lock is redirected")
    if LOCK_FILE.exists():
        if not LOCK_FILE.is_file() or LOCK_FILE.stat().st_size > 16 * 1024 * 1024:
            raise NativeStateError("Hermes Hub lock is not a bounded regular file")
        try:
            data = json.loads(LOCK_FILE.read_text())
        except (ValueError, OSError):
            raise NativeStateError("Hermes Hub lock is unreadable or invalid")
        if not isinstance(data, dict) or not isinstance(data.get("installed"), dict):
            raise NativeStateError("Hermes Hub lock is invalid")
        if any(not isinstance(entry, dict) for entry in data["installed"].values()):
            raise NativeStateError("Hermes Hub record is invalid")
    return HubLockFile()

def run(request):
    global target_mutation_started
    name = request["name"]
    target = SKILLS_DIR / name
    if str(target) != request["target"] or target.is_symlink():
        raise NativeStateError("Hermes Skill target is invalid")
    lock = checked_lock()
    entry = lock.get_installed(name)
    if entry is not None and entry.get("install_path") != name:
        raise NativeStateError("Hermes Hub record points to another Skill path")
    if entry is not None and not isinstance(entry.get("metadata", {}), dict):
        raise NativeStateError("Hermes Hub provenance metadata is invalid")
    operation = request["operation"]
    if entry is not None:
        identity = entry.get("metadata", {}).get("clawdi_source_identity")
        if not any(
            (identity is None or identity == expected["identity"])
            and entry.get("source") == expected["source"]
            and entry.get("identifier") == expected["identifier"]
            for expected in request["ownedSources"]
        ):
            raise NativeStateError("Hermes Hub Skill was replaced by another source")
    if operation == "remove":
        if entry is not None:
            target_mutation_started = True
            allowed, reason = uninstall_skill(name)
            if allowed is not True:
                return {"ok": False, "error": reason}
        elif target.exists():
            # A legacy Clawdi reservation owns local files, not a Hub record.
            # Guard native name lookup before invoking the public delete tool.
            from agent.skill_utils import get_all_skills_dirs, is_excluded_skill_path
            from tools.skill_manager_tool import skill_manage
            found = next((p.parent for root in get_all_skills_dirs() if root.exists()
                          for p in root.rglob("SKILL.md")
                          if not is_excluded_skill_path(p) and p.parent.name == name), None)
            if found != target:
                raise NativeStateError("Hermes local Skill lookup does not match the owned target")
            target_mutation_started = True
            result = json.loads(skill_manage(action="delete", name=name))
            if result.get("success") is not True:
                return {"ok": False, "error": result.get("error", "Hermes local Skill deletion failed")}
        clear_skills_system_prompt_cache(clear_snapshot=True)
        return {"ok": True, "matches": not target.exists() and not checked_lock().get_installed(name)}
    if operation != "install":
        raise ValueError("Unknown Hermes Skill operation")
    bundle = SkillBundle(
        name=name,
        files={path: base64.b64decode(data, validate=True) for path, data in request["files"].items()},
        source=request["source"], identifier=request["identifier"], trust_level="community",
        metadata={"clawdi_source_identity": request["identity"]},
    )
    quarantine = quarantine_bundle(bundle)
    try:
        scan = scan_skill(quarantine, source=request["scanSource"])
        allowed, reason = should_allow_install(scan, force=False)
        if allowed is not True:
            return {"ok": False, "error": reason}
        bundle.trust_level = scan.trust_level
        checked_lock()
        target_mutation_started = True
        install_from_quarantine(quarantine, name, "", bundle, scan)
        clear_skills_system_prompt_cache(clear_snapshot=True)
    finally:
        # Clean only this invocation's quarantine, never the target or lock.
        if quarantine.exists():
            shutil.rmtree(quarantine)
    return {"ok": True}

try:
    result = run(json.load(sys.stdin))
except NativeStateError as error:
    result = {"ok": False, "error": str(error)}
except Exception as error:
    result = {"ok": False, "error": "Hermes native Skill operation failed (" + type(error).__name__ + ")"}
print(json.dumps({**result, "targetMutationStarted": target_mutation_started}))
`;

function nativeSource(skillId: string, source: HostedSkillSource) {
	const identifier =
		source.type === "github"
			? `${source.url.slice("https://github.com/".length)}${source.path ? `/${source.path}` : ""}`
			: `project/${source.projectId}/${skillId}@${source.contentHash}`;
	return {
		source: source.type === "github" ? "github" : "clawdi",
		identifier,
		scanSource: identifier,
		identity: hostedSkillArchiveSourceIdentity(skillId, source),
	};
}

function nativeSkillError(
	message: string,
	targetMutationStarted?: boolean,
): ManagedSkillResourceError {
	const error = new ManagedSkillResourceError(message);
	if (targetMutationStarted !== undefined) error.targetMutationStarted = targetMutationStarted;
	return error;
}

function nativeOperation(
	home: string,
	targetDir: string,
	operation: "install" | "remove",
	payload: Record<string, unknown> = {},
): boolean {
	const name = basename(targetDir);
	const target = resolve(targetDir);
	if (
		!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ||
		target !== join(home, ".hermes", "skills", name)
	) {
		throw nativeSkillError("Hermes Skill target is invalid", false);
	}
	const appRoot = join(home, ".hermes", "hermes-agent");
	const result = spawnRuntimeUserCommand(
		join(appRoot, "venv", "bin", "python"),
		["-B", "-c", HERMES_SKILL_OPERATION],
		home,
		appRoot,
		{
			input: JSON.stringify({ ...payload, operation, name, target }),
			environmentOverrides: { HERMES_HOME: join(home, ".hermes"), PYTHONNOUSERSITE: "1" },
			timeoutMs: 120_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
	if (result.status !== 0) {
		const notStarted =
			result.error &&
			"code" in result.error &&
			(result.error.code === "ENOENT" || result.error.code === "EACCES");
		throw nativeSkillError("Hermes native Skill process failed", notStarted ? false : undefined);
	}
	let response: Record<string, unknown> | null;
	try {
		response = recordValue(JSON.parse(String(result.stdout).trim().split("\n").at(-1) ?? ""));
	} catch {
		throw new ManagedSkillResourceError("Hermes native Skill response is invalid");
	}
	if (response?.ok !== true) {
		throw nativeSkillError(
			typeof response?.error === "string" ? response.error : "Hermes native Skill operation failed",
			typeof response?.targetMutationStarted === "boolean"
				? response.targetMutationStarted
				: undefined,
		);
	}
	return response.matches === true;
}

export function readHostedHermesSkillRecords(home: string): Record<string, unknown> {
	const hub = join(home, ".hermes", "skills", ".hub");
	try {
		if (!lstatSync(hub).isDirectory()) throw new Error("invalid Hub directory");
		const path = join(hub, "lock.json");
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("invalid Hub lock");
		const lock = recordValue(JSON.parse(readFileSync(path, "utf8")));
		const installed = recordValue(lock?.installed);
		if (!installed || Object.values(installed).some((entry) => !recordValue(entry))) {
			throw new Error("invalid Hub records");
		}
		return installed;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw new ManagedSkillResourceError("Hermes Hub lock is unreadable or invalid");
	}
}

export function hostedHermesSkillSourceMatches(
	home: string,
	targetDir: string,
	source?: HostedSkillSource,
	records?: Record<string, unknown>,
): boolean {
	if (!source) return true;
	return hostedHermesSkillRecordMatches(
		home,
		targetDir,
		hostedSkillArchiveSourceIdentity(basename(targetDir), source),
		records ?? readHostedHermesSkillRecords(home),
	);
}

export function hostedHermesSkillRecordMatches(
	home: string,
	targetDir: string,
	sourceIdentity: string,
	records: Record<string, unknown>,
): boolean {
	const name = basename(targetDir);
	const expected = nativeOwnedSource(targetDir, sourceIdentity);
	const entry = recordValue(records[name]);
	return (
		resolve(targetDir) === join(home, ".hermes", "skills", name) &&
		entry?.install_path === name &&
		entry.source === expected.source &&
		entry.identifier === expected.identifier &&
		recordValue(entry.metadata)?.clawdi_source_identity === expected.identity
	);
}

function nativeOwnedSource(targetDir: string, identity: string) {
	const [type, skillId, origin, pathOrHash, commit] = identity.split("\0");
	if (
		skillId !== basename(targetDir) ||
		!origin ||
		pathOrHash === undefined ||
		(type !== "github" && type !== "project") ||
		(type === "github" && !commit)
	) {
		throw nativeSkillError("Hermes managed Skill source identity is invalid", false);
	}
	return {
		identity,
		source: type === "github" ? "github" : "clawdi",
		identifier:
			type === "github"
				? `${origin.slice("https://github.com/".length)}${pathOrHash ? `/${pathOrHash}` : ""}`
				: `project/${origin}/${skillId}@${pathOrHash}`,
	};
}

/** Called only while holding a Clawdi managed reservation for this target. */
export function removeHostedHermesSkill(
	home: string,
	targetDir: string,
	identities: readonly string[],
): void {
	const ownedSources = identities.map((identity) => nativeOwnedSource(targetDir, identity));
	if (!ownedSources.length || !nativeOperation(home, targetDir, "remove", { ownedSources })) {
		throw new ManagedSkillResourceError("Hermes native Skill removal could not be verified");
	}
}

export function activateHostedHermesSkill(input: {
	home: string;
	sourceDir: string;
	targetDir: string;
	source?: HostedSkillSource;
	ownedSourceIdentities?: readonly string[];
}): void {
	const { home, sourceDir, targetDir, source } = input;
	if (!source) {
		// The platform's bundled bootstrap remains a platform-owned local Skill.
		replaceManagedSkillDirectoryAtomic(sourceDir, targetDir, {
			afterActivate: () => {
				if (!managedSkillTargetMatchesSource(sourceDir, targetDir)) {
					throw new ManagedSkillResourceError(
						"Hermes bundled Skill activation changed exact source bytes",
					);
				}
			},
		});
		return;
	}
	const collected = collectManagedSkillTree(sourceDir);
	if (collected.status !== "collected")
		throw nativeSkillError("Hermes prepared Skill tree is unsafe", false);
	const desired = nativeSource(basename(targetDir), source);
	nativeOperation(home, targetDir, "install", {
		...desired,
		ownedSources: [
			desired,
			...(input.ownedSourceIdentities ?? []).map((identity) =>
				nativeOwnedSource(targetDir, identity),
			),
		],
		files: Object.fromEntries(
			[...collected.tree].map(([path, bytes]) => [path, bytes.toString("base64")]),
		),
	});
	if (
		!managedSkillTargetMatchesSource(sourceDir, targetDir) ||
		!hostedHermesSkillSourceMatches(home, targetDir, source)
	) {
		throw new ManagedSkillResourceError("Hermes native Skill installation could not be verified");
	}
}
