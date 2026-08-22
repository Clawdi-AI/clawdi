import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	collectRuntimeUserManagedSkillTree,
	HERMES_MANAGED_SKILL_RECEIPT_SCHEMA,
	ManagedSkillResourceError,
	managedSkillMarkerMatchesIdentity,
	managedSkillReceiptIdentityState,
	managedSkillReceiptMatchesIdentity,
	managedSkillReceiptPath,
	managedSkillTreesEqual,
	withStagedManagedSkill,
	writeManagedSkillReceipt,
} from "./managed-skill-delivery";
import { replaceManagedSkillDirectoryAtomic } from "./managed-skill-reservation";
import {
	executableExists,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";

const HERMES_SKILL_COMMAND_TIMEOUT_MS = 120_000;

export interface HostedHermesSkillExactSourceDriver {
	target?(input: { home: string; skill: PreparedHostedSourcedSkill }): string;
	install(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skill: PreparedHostedSourcedSkill;
		targetDir?: string;
		previouslyReserved: boolean;
		previousTargetDir?: string;
		previousOwnershipIdentity?: string;
	}): "installed" | "unchanged";
	anchorOwnership(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): void;
	verifyOwned(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skill: PreparedHostedSourcedSkill;
		targetDir?: string;
	}): boolean;
	hasOwnershipReceipt(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): boolean;
	uninstall(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): "absent" | "removed";
	cleanupManifestOwned(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): "absent" | "removed";
}

function targetDir(home: string, skillId: string): string {
	// Hermes a77ee88 discovers profile-local Skills here without invoking the
	// hub install guard. Revisit if upstream starts guarding this path
	// (NousResearch/hermes-agent#89704, Clawdi-AI/clawdi#1148).
	return join(home, ".hermes", "skills", skillId);
}

function commandPath(home: string, appRoot: string): string {
	return withRuntimeUserFileAccess(() => {
		for (const candidate of [
			join(appRoot, "venv", "bin", "hermes"),
			join(home, ".local", "bin", "hermes"),
		]) {
			if (executableExists(candidate)) return candidate;
		}
		throw new Error("installed Hermes Skill CLI is unavailable");
	});
}

function receiptInput(
	managedResourceRoot: string,
	skillId: string,
	ownershipIdentity: string,
	target: string,
) {
	return {
		path: managedSkillReceiptPath(managedResourceRoot, "hermes", skillId),
		managedResourceRoot,
		schemaVersion: HERMES_MANAGED_SKILL_RECEIPT_SCHEMA,
		skillId,
		ownershipIdentity,
		target,
	};
}

function assertActivationMatchesSource(sourceDir: string, target: string): void {
	const source = collectManagedSkillTree(sourceDir);
	const installed = collectRuntimeUserManagedSkillTree(target);
	if (source.status !== "collected") {
		throw new Error(`prepared Hermes Skill tree is ${source.status}`);
	}
	if (installed.status !== "collected") {
		throw new ManagedSkillResourceError(`installed Hermes Skill tree is ${installed.status}`);
	}
	if (!managedSkillTreesEqual(source.tree, installed.tree)) {
		throw new ManagedSkillResourceError("Hermes Skill activation changed exact source bytes");
	}
}

const HERMES_URL_SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const HERMES_RESERVED_URL_SKILL_NAMES = new Set(["skill", "readme", "index", "unnamed-skill"]);

function validHermesUrlSkillName(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const candidate = value.trim().toLowerCase();
	return (
		candidate.length > 0 &&
		!HERMES_RESERVED_URL_SKILL_NAMES.has(candidate) &&
		HERMES_URL_SKILL_NAME_PATTERN.test(candidate)
	);
}

function readHermesInstalledLock(home: string): {
	skillsRoot: string;
	installed: Record<string, unknown>;
} | null {
	const skillsRoot = resolve(home, ".hermes", "skills");
	const lockPath = join(skillsRoot, ".hub", "lock.json");
	if (!existsSync(lockPath)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		throw new ManagedSkillResourceError("Hermes Skill lock is invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ManagedSkillResourceError("Hermes Skill lock is invalid");
	}
	const lock = parsed as Record<string, unknown>;
	if (
		lock.version !== 1 ||
		typeof lock.installed !== "object" ||
		lock.installed === null ||
		Array.isArray(lock.installed)
	) {
		throw new ManagedSkillResourceError("Hermes Skill lock is invalid");
	}
	return { skillsRoot, installed: lock.installed as Record<string, unknown> };
}

function hermesLockTarget(skillsRoot: string, name: string, installPath: unknown): string {
	if (
		!validHermesUrlSkillName(name) ||
		typeof installPath !== "string" ||
		installPath !== name ||
		dirname(resolve(skillsRoot, installPath)) !== skillsRoot ||
		basename(resolve(skillsRoot, installPath)) !== name
	) {
		throw new ManagedSkillResourceError("Hermes Skill lock install path is unsafe");
	}
	return join(skillsRoot, installPath);
}

function legacyLoopbackHubTarget(home: string, target: string): string | null {
	const expected = resolve(target);
	return withRuntimeUserFileAccess(() => {
		const lock = readHermesInstalledLock(home);
		if (!lock || dirname(expected) !== lock.skillsRoot) return null;
		const name = basename(expected);
		const entry = lock.installed[name];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		if (record.source !== "url") return null;
		if (typeof record.identifier !== "string") {
			throw new ManagedSkillResourceError("Hermes Skill lock source is invalid");
		}
		let source: URL;
		try {
			source = new URL(record.identifier);
		} catch {
			throw new ManagedSkillResourceError("Hermes Skill lock source is invalid");
		}
		if (source.protocol !== "http:" || source.hostname !== "127.0.0.1") return null;
		if (
			source.href !== record.identifier ||
			!source.port ||
			Number(source.port) < 1 ||
			source.username ||
			source.password ||
			source.search ||
			source.hash ||
			!/^\/0[a-f0-9]{64}\/SKILL\.md$/.test(source.pathname)
		) {
			throw new ManagedSkillResourceError("Hermes Skill lock source is invalid");
		}
		if (hermesLockTarget(lock.skillsRoot, name, record.install_path) !== expected) {
			throw new ManagedSkillResourceError("Hermes Skill lock install path is unsafe");
		}
		let identityMatches = 0;
		for (const value of Object.values(lock.installed)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const candidate = value as Record<string, unknown>;
			if (candidate.identifier !== record.identifier) continue;
			if (candidate.source !== "url") {
				throw new ManagedSkillResourceError("Hermes Skill lock source is invalid");
			}
			identityMatches += 1;
		}
		if (identityMatches !== 1) {
			throw new ManagedSkillResourceError("Hermes Skill lock source identity is ambiguous");
		}
		return expected;
	});
}

function hermesLockHasTarget(home: string, target: string): boolean {
	const expected = resolve(target);
	return withRuntimeUserFileAccess(() => {
		const lock = readHermesInstalledLock(home);
		if (!lock || dirname(expected) !== lock.skillsRoot) return false;
		return Object.hasOwn(lock.installed, basename(expected));
	});
}

function runHermesUninstall(
	input: { home: string; appRoot: string },
	skillName: string,
): ReturnType<typeof spawnRuntimeUserCommand> {
	// Feed stdin for Hermes 0.20 variants that predate the --yes flag.
	return spawnRuntimeUserCommand(
		commandPath(input.home, input.appRoot),
		["skills", "uninstall", skillName],
		input.home,
		input.appRoot,
		{
			input: "y\n",
			timeoutMs: HERMES_SKILL_COMMAND_TIMEOUT_MS,
			maxBufferBytes: 1024 * 1024,
		},
	);
}

function hermesCommandOutput(result: ReturnType<typeof runHermesUninstall>): string {
	return [result.stderr, result.stdout]
		.map((value) => String(value ?? "").trim())
		.filter(Boolean)
		.join("\n");
}

function migrateLegacyLoopbackHubInstall(input: {
	home: string;
	appRoot: string;
	managedResourceRoot: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
}): void {
	const receipt = receiptInput(
		input.managedResourceRoot,
		input.skillId,
		input.ownershipIdentity,
		input.target,
	);
	if (!managedSkillReceiptMatchesIdentity(receipt)) return;
	if (legacyLoopbackHubTarget(input.home, input.target) !== input.target) return;

	// SUNSET(#1148): remove after the fleet has fully upgraded through CLI 0.14.10.
	const result = runHermesUninstall(input, basename(input.target));
	if (result.status !== 0) {
		throw new ManagedSkillResourceError(
			`Hermes official Skill uninstall failed: ${hermesCommandOutput(result) || result.error?.message || "unknown error"}`,
		);
	}
	if (withRuntimeUserFileAccess(() => existsSync(input.target))) {
		throw new ManagedSkillResourceError(
			"Hermes official Skill uninstall did not remove the Skill target",
		);
	}
	if (hermesLockHasTarget(input.home, input.target)) {
		throw new ManagedSkillResourceError(
			"Hermes official Skill uninstall did not remove the Skill lock entry",
		);
	}
}

function removeOwnedSkill(input: {
	home: string;
	managedResourceRoot: string;
	skillId: string;
	ownershipIdentity: string;
	targetDir?: string;
}): "absent" | "removed" {
	const target = resolve(input.targetDir ?? targetDir(input.home, input.skillId));
	const receipt = receiptInput(
		input.managedResourceRoot,
		input.skillId,
		input.ownershipIdentity,
		target,
	);
	const receiptState = managedSkillReceiptIdentityState(receipt);
	if (receiptState === "absent") {
		rmSync(receipt.path, { force: true });
		return "absent";
	}
	if (receiptState === "unsafe") throw new Error("Hermes Skill tree is unsafe");
	if (receiptState !== "matched") {
		throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
	}
	withRuntimeUserFileAccess(() => {
		rmSync(target, { recursive: true });
	});
	rmSync(receipt.path, { force: true });
	return "removed";
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	target(input) {
		return targetDir(input.home, input.skill.skillId);
	},
	install(input) {
		const target = resolve(input.targetDir ?? targetDir(input.home, input.skill.skillId));
		if (input.previouslyReserved) {
			migrateLegacyLoopbackHubInstall({
				home: input.home,
				appRoot: input.appRoot,
				managedResourceRoot: input.managedResourceRoot,
				skillId: input.skill.skillId,
				ownershipIdentity: input.previousOwnershipIdentity ?? input.skill.sourceIdentity,
				target: resolve(input.previousTargetDir ?? target),
			});
		}
		const receipt = receiptInput(
			input.managedResourceRoot,
			input.skill.skillId,
			input.skill.sourceIdentity,
			target,
		);
		if (withRuntimeUserFileAccess(() => existsSync(target)) && !input.previouslyReserved) {
			throw new Error("Hermes Skill target is not paired with a manifest reservation");
		}
		if (managedSkillReceiptMatchesIdentity(receipt)) return "unchanged";
		return withStagedManagedSkill(input.skill, (sourceDir) => {
			replaceManagedSkillDirectoryAtomic(sourceDir, target, {
				receipt: receipt.path,
				afterActivate: () => {
					assertActivationMatchesSource(sourceDir, target);
					writeManagedSkillReceipt(receipt);
				},
			});
			return "installed" as const;
		});
	},
	anchorOwnership(input) {
		writeManagedSkillReceipt(
			receiptInput(
				input.managedResourceRoot,
				input.skillId,
				input.ownershipIdentity,
				input.targetDir ?? targetDir(input.home, input.skillId),
			),
		);
	},
	verifyOwned(input) {
		return managedSkillReceiptMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.skill.skillId,
				input.skill.sourceIdentity,
				input.targetDir ?? targetDir(input.home, input.skill.skillId),
			),
		);
	},
	hasOwnershipReceipt(input) {
		return managedSkillMarkerMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.skillId,
				input.ownershipIdentity,
				input.targetDir ?? targetDir(input.home, input.skillId),
			),
		);
	},
	uninstall(input) {
		return removeOwnedSkill(input);
	},
	cleanupManifestOwned(input) {
		return removeOwnedSkill(input);
	},
};
