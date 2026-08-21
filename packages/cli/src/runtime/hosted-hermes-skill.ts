import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
	withManagedTargetRollback,
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

function commandPath(home: string, appRoot: string): string {
	return withRuntimeUserFileAccess(() => {
		for (const candidate of [
			join(appRoot, "venv", "bin", "hermes"),
			join(home, ".local", "bin", "hermes"),
		])
			if (executableExists(candidate)) return candidate;
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

function rawSkillUrl(skill: PreparedHostedSourcedSkill): string {
	if (skill.source.type === "project") return skill.source.installUrl;
	if (skill.source.type === "bundled") {
		throw new Error("bundled Hermes Skills do not have a remote install URL");
	}
	const repository = new URL(skill.source.url);
	const [owner, repo] = repository.pathname.slice(1).split("/");
	if (!owner || !repo)
		throw new Error("Hermes exact-source URL requires a canonical GitHub repository");
	const encodedPath = skill.source.path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const skillPath = encodedPath ? `${encodedPath}/SKILL.md` : "SKILL.md";
	return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${skill.source.commit}/${skillPath}`;
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

function frontmatterName(sourceDir: string): string | null {
	const content = readFileSync(join(sourceDir, "SKILL.md"), "utf8").replace(/^\uFEFF/, "");
	if (!content.startsWith("---")) return null;
	const body = content.slice(3);
	const end = /\n---\s*\n/.exec(body);
	if (!end) return null;
	try {
		const parsed = parseYaml(body.slice(0, end.index));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			validHermesUrlSkillName((parsed as Record<string, unknown>).name)
		) {
			return String((parsed as Record<string, unknown>).name).trim();
		}
	} catch {
		return null;
	}
	return null;
}

function urlSkillName(url: string): string | null {
	const parts = new URL(url).pathname.split("/").filter(Boolean);
	if (parts.at(-1)?.toLowerCase() === "skill.md" && parts.length >= 2) {
		const candidate = parts.at(-2);
		if (validHermesUrlSkillName(candidate)) return candidate;
	}
	const candidate = parts.at(-1)?.replace(/\.md$/i, "");
	return validHermesUrlSkillName(candidate) ? candidate : null;
}

function plannedNativeTarget(
	home: string,
	skill: PreparedHostedSourcedSkill,
	sourceDir: string,
): string {
	if (skill.source.type === "bundled") {
		return join(home, ".hermes", "skills", skill.skillId);
	}
	const nativeName =
		frontmatterName(sourceDir) ?? urlSkillName(rawSkillUrl(skill)) ?? skill.skillId;
	return join(home, ".hermes", "skills", nativeName);
}

function hermesCommandOutput(result: ReturnType<typeof runHermes>): string {
	return [result.stderr, result.stdout]
		.map((value) => String(value ?? "").trim())
		.filter(Boolean)
		.join("\n");
}

function installedTargetFromHermesLock(home: string, identifier: string): string | null {
	return withRuntimeUserFileAccess(() => {
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
		if (lock.version !== 1 || typeof lock.installed !== "object" || lock.installed === null) {
			throw new ManagedSkillResourceError("Hermes Skill lock is invalid");
		}
		const matches: Array<{ name: string; installPath: string }> = [];
		for (const [name, value] of Object.entries(lock.installed as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const entry = value as Record<string, unknown>;
			if (entry.identifier !== identifier) continue;
			if (entry.source !== "url") {
				throw new ManagedSkillResourceError("Hermes Skill lock source is invalid");
			}
			if (typeof entry.install_path !== "string") {
				throw new ManagedSkillResourceError("Hermes Skill lock install path is invalid");
			}
			matches.push({ name, installPath: entry.install_path });
		}
		if (matches.length === 0) return null;
		if (matches.length !== 1) {
			throw new ManagedSkillResourceError("Hermes Skill lock source identity is ambiguous");
		}
		const [{ name, installPath }] = matches;
		if (
			!validHermesUrlSkillName(name) ||
			installPath !== name ||
			dirname(resolve(skillsRoot, installPath)) !== skillsRoot ||
			basename(resolve(skillsRoot, installPath)) !== name
		) {
			throw new ManagedSkillResourceError("Hermes Skill lock install path is unsafe");
		}
		return join(skillsRoot, installPath);
	});
}

function runHermes(input: { home: string; appRoot: string }, args: string[], stdin?: string) {
	return spawnRuntimeUserCommand(
		commandPath(input.home, input.appRoot),
		args,
		input.home,
		input.appRoot,
		{
			input: stdin,
			timeoutMs: HERMES_SKILL_COMMAND_TIMEOUT_MS,
			maxBufferBytes: 1024 * 1024,
		},
	);
}

function runHermesUninstall(input: { home: string; appRoot: string }, skillId: string) {
	// Hermes exposes no --yes flag for this subcommand; its confirmation reads stdin.
	return runHermes(input, ["skills", "uninstall", skillId], "y\n");
}

function assertBundledResultMatches(sourceDir: string, target: string): void {
	const source = collectManagedSkillTree(sourceDir);
	const installed = collectRuntimeUserManagedSkillTree(target);
	if (source.status !== "collected") {
		throw new Error(`prepared Hermes bundled Skill tree is ${source.status}`);
	}
	if (installed.status !== "collected") {
		throw new ManagedSkillResourceError(
			`installed Hermes bundled Skill tree is ${installed.status}`,
		);
	}
	if (!managedSkillTreesEqual(source.tree, installed.tree)) {
		throw new ManagedSkillResourceError(
			"Hermes bundled Skill activation changed exact source bytes",
		);
	}
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	target(input) {
		if (input.skill.source.type !== "bundled") {
			const installed = installedTargetFromHermesLock(input.home, rawSkillUrl(input.skill));
			if (installed) return installed;
		}
		return withStagedManagedSkill(input.skill, (sourceDir) =>
			plannedNativeTarget(input.home, input.skill, sourceDir),
		);
	},
	install(input) {
		const installedBefore =
			input.skill.source.type === "bundled"
				? null
				: installedTargetFromHermesLock(input.home, rawSkillUrl(input.skill));
		const target = resolve(
			input.targetDir ??
				installedBefore ??
				withStagedManagedSkill(input.skill, (sourceDir) =>
					plannedNativeTarget(input.home, input.skill, sourceDir),
				),
		);
		const receipt = receiptInput(
			input.managedResourceRoot,
			input.skill.skillId,
			input.skill.sourceIdentity,
			target,
		);
		if (withRuntimeUserFileAccess(() => existsSync(target)) && !input.previouslyReserved)
			throw new Error("Hermes Skill target is not paired with a manifest reservation");
		if (managedSkillReceiptMatchesIdentity(receipt)) {
			if (
				input.skill.source.type === "bundled" ||
				installedTargetFromHermesLock(input.home, rawSkillUrl(input.skill)) === target
			) {
				return "unchanged";
			}
		}
		return withStagedManagedSkill(input.skill, (sourceDir) => {
			const plannedTarget =
				installedBefore ?? plannedNativeTarget(input.home, input.skill, sourceDir);
			if (resolve(plannedTarget) !== target) {
				throw new Error("Hermes Skill planned target changed during installation");
			}
			if (input.skill.source.type === "bundled") {
				replaceManagedSkillDirectoryAtomic(sourceDir, target, {
					receipt: receipt.path,
					afterActivate: () => {
						assertBundledResultMatches(sourceDir, target);
						writeManagedSkillReceipt(receipt);
					},
				});
				return "installed" as const;
			}
			return withManagedTargetRollback({
				target,
				receipt: receipt.path,
				operation: () => {
					const args = [
						"skills",
						"install",
						rawSkillUrl(input.skill),
						"--name",
						input.skill.skillId,
						"--yes",
					];
					if (input.previouslyReserved) args.push("--force");
					const result = runHermes(input, args);
					if (result.status !== 0)
						throw new ManagedSkillResourceError(
							`Hermes official Skill install failed: ${hermesCommandOutput(result) || result.error?.message || "unknown error"}`,
						);
					const installedTarget = installedTargetFromHermesLock(
						input.home,
						rawSkillUrl(input.skill),
					);
					if (!installedTarget) {
						throw new ManagedSkillResourceError(
							`Hermes official Skill install did not record an installed target: ${hermesCommandOutput(result) || "unknown error"}`,
						);
					}
					if (installedTarget !== target) {
						throw new ManagedSkillResourceError(
							`Hermes official Skill install recorded an unexpected target: ${installedTarget}`,
						);
					}
					writeManagedSkillReceipt(
						receiptInput(
							input.managedResourceRoot,
							input.skill.skillId,
							input.skill.sourceIdentity,
							installedTarget,
						),
					);
					return "installed" as const;
				},
			});
		});
	},
	anchorOwnership(input) {
		writeManagedSkillReceipt(
			receiptInput(
				input.managedResourceRoot,
				input.skillId,
				input.ownershipIdentity,
				input.targetDir ?? join(input.home, ".hermes", "skills", input.skillId),
			),
		);
	},
	verifyOwned(input) {
		return managedSkillReceiptMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.skill.skillId,
				input.skill.sourceIdentity,
				input.targetDir ??
					withStagedManagedSkill(input.skill, (sourceDir) =>
						plannedNativeTarget(input.home, input.skill, sourceDir),
					),
			),
		);
	},
	hasOwnershipReceipt(input) {
		return managedSkillMarkerMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.skillId,
				input.ownershipIdentity,
				input.targetDir ?? join(input.home, ".hermes", "skills", input.skillId),
			),
		);
	},
	uninstall(input) {
		const target = resolve(input.targetDir ?? join(input.home, ".hermes", "skills", input.skillId));
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
		if (receiptState !== "matched")
			throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
		const result = runHermesUninstall(input, basename(target));
		if (result.status !== 0)
			throw new ManagedSkillResourceError(
				`Hermes official Skill uninstall failed: ${hermesCommandOutput(result) || result.error?.message || "unknown error"}`,
			);
		if (withRuntimeUserFileAccess(() => existsSync(target)))
			throw new ManagedSkillResourceError(
				"Hermes official Skill uninstall did not remove the Skill target",
			);
		rmSync(receipt.path, { force: true });
		return "removed";
	},
	cleanupManifestOwned(input) {
		const target = resolve(input.targetDir ?? join(input.home, ".hermes", "skills", input.skillId));
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
	},
};
