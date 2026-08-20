import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	managedSkillMarkerMatchesIdentity,
	managedSkillReceiptMatchesIdentity,
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

const RECEIPT_SCHEMA = "clawdi.hermesManifestSkillReceipt.v2";

export interface HostedHermesSkillExactSourceDriver {
	install(input: {
		home: string;
		appRoot: string;
		skill: PreparedHostedSourcedSkill;
		previouslyReserved: boolean;
	}): "installed" | "unchanged";
	verifyOwned(input: { home: string; appRoot: string; skill: PreparedHostedSourcedSkill }): boolean;
	hasOwnershipReceipt(input: { home: string; skillId: string; ownershipIdentity: string }): boolean;
	uninstall(input: {
		home: string;
		appRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): "absent" | "removed";
	cleanupManifestOwned(input: {
		home: string;
		skillId: string;
		ownershipIdentity: string;
	}): "absent" | "removed";
}

function commandPath(home: string, appRoot: string): string {
	for (const candidate of [
		join(appRoot, "venv", "bin", "hermes"),
		join(home, ".local", "bin", "hermes"),
	])
		if (executableExists(candidate)) return candidate;
	throw new Error("installed Hermes Skill CLI is unavailable");
}
const targetDir = (home: string, skillId: string) => join(home, ".hermes", "skills", skillId);
const receiptPath = (home: string, skillId: string) =>
	join(home, ".hermes", "skills", ".clawdi-manifest-receipts", `${skillId}.json`);

function receiptInput(home: string, skillId: string, ownershipIdentity: string) {
	return {
		path: receiptPath(home, skillId),
		schemaVersion: RECEIPT_SCHEMA,
		skillId,
		ownershipIdentity,
		target: targetDir(home, skillId),
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

function runHermes(input: { home: string; appRoot: string }, args: string[], stdin?: string) {
	return spawnRuntimeUserCommand(
		commandPath(input.home, input.appRoot),
		args,
		input.home,
		input.appRoot,
		{
			input: stdin,
			timeoutMs: 120_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
}

function runHermesUninstall(input: { home: string; appRoot: string }, skillId: string) {
	// Hermes exposes no --yes flag for this subcommand; its confirmation reads stdin.
	return runHermes(input, ["skills", "uninstall", skillId], "y\n");
}

const HERMES_SUPPORT_DIRS = new Set(["references", "templates", "scripts", "assets", "examples"]);
const HERMES_SUPPORT_REFERENCE =
	/(?:\]\(|`|(?:^|[\s"']))((?:references|templates|scripts|assets|examples)\/[^\s)`"'<>]+)/gm;

/** Mirrors Hermes UrlSource at NousResearch/hermes-agent@a77ee88ce29c4f1d89f8d60e5b662322645072d8. */
function expectedHermesNativeTree(sourceDir: string) {
	const catalogTree = collectManagedSkillTree(sourceDir);
	const skillMd = catalogTree?.get("SKILL.md");
	if (!catalogTree || !skillMd) return null;
	const text = skillMd.toString("utf8").replaceAll("\\", "/");
	if (
		/(?:references|templates|scripts|assets|examples)\/(?:[^\s)`"'<>]*\/)?\.\.(?:\/|$)/m.test(text)
	)
		return null;
	// UrlSource fetches SKILL.md as HTTP text and quarantine_bundle writes that
	// text as UTF-8. Support files stay byte-for-byte HTTP payloads.
	const expected = new Map<string, Buffer>([
		["SKILL.md", Buffer.from(skillMd.toString("utf8"), "utf8")],
	]);
	for (const match of text.matchAll(HERMES_SUPPORT_REFERENCE)) {
		let relative: string;
		try {
			relative = decodeURIComponent(
				(match[1] ?? "").replace(/[.,;:]+$/, "").split(/[?#]/, 1)[0] ?? "",
			);
		} catch {
			return null;
		}
		const segments = relative.split("/");
		if (
			!HERMES_SUPPORT_DIRS.has(segments[0] ?? "") ||
			segments.some((segment) => !segment || segment === "." || segment === "..")
		)
			return null;
		const bytes = catalogTree.get(relative);
		if (!bytes) return null;
		expected.set(relative, bytes);
	}
	return expected;
}

function nativeResultMatches(
	skill: PreparedHostedSourcedSkill,
	sourceDir: string,
	target: string,
): boolean {
	return managedSkillTreesEqual(
		skill.source.type === "bundled"
			? collectManagedSkillTree(sourceDir)
			: expectedHermesNativeTree(sourceDir),
		collectManagedSkillTree(target),
	);
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	install(input) {
		return withStagedManagedSkill(input.skill, (sourceDir) => {
			const target = targetDir(input.home, input.skill.skillId);
			const receipt = receiptInput(input.home, input.skill.skillId, input.skill.sourceIdentity);
			const hadTarget = existsSync(target);
			if (hadTarget && !input.previouslyReserved)
				throw new Error("Hermes Skill target is not paired with a manifest reservation");
			if (
				nativeResultMatches(input.skill, sourceDir, target) &&
				managedSkillReceiptMatchesIdentity(receipt)
			)
				return "unchanged";
			return withManagedTargetRollback({
				target,
				receipt: receipt.path,
				operation: () => {
					if (input.skill.source.type === "bundled") {
						withRuntimeUserFileAccess(() => replaceManagedSkillDirectoryAtomic(sourceDir, target));
						if (!nativeResultMatches(input.skill, sourceDir, target)) {
							throw new Error("Hermes bundled Skill activation changed exact source bytes");
						}
						writeManagedSkillReceipt(receipt);
						return "installed" as const;
					}
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
						throw new Error(
							`Hermes official Skill install failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
						);
					if (!nativeResultMatches(input.skill, sourceDir, target)) {
						if (!hadTarget && existsSync(target)) {
							const rollback = runHermesUninstall(input, input.skill.skillId);
							if (rollback.status !== 0 || existsSync(target))
								throw new Error(
									`Hermes official install produced invalid Skill bytes and native rollback failed: ${String(rollback.stderr || rollback.stdout).trim() || (existsSync(target) ? "Skill target still exists" : "unknown error")}`,
								);
						}
						throw new Error(
							"Hermes official install did not preserve the exact native catalog projection",
						);
					}
					writeManagedSkillReceipt(receipt);
					return "installed" as const;
				},
			});
		});
	},
	verifyOwned(input) {
		return withStagedManagedSkill(
			input.skill,
			(sourceDir) =>
				nativeResultMatches(input.skill, sourceDir, targetDir(input.home, input.skill.skillId)) &&
				managedSkillReceiptMatchesIdentity(
					receiptInput(input.home, input.skill.skillId, input.skill.sourceIdentity),
				),
		);
	},
	hasOwnershipReceipt(input) {
		return managedSkillMarkerMatchesIdentity(
			receiptInput(input.home, input.skillId, input.ownershipIdentity),
		);
	},
	uninstall(input) {
		const target = targetDir(input.home, input.skillId);
		const receipt = {
			path: receiptPath(input.home, input.skillId),
			schemaVersion: RECEIPT_SCHEMA,
			skillId: input.skillId,
			ownershipIdentity: input.ownershipIdentity,
			target,
		};
		if (!existsSync(target)) {
			rmSync(receipt.path, { force: true });
			return "absent";
		}
		if (!managedSkillReceiptMatchesIdentity(receipt))
			throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
		const result = runHermesUninstall(input, input.skillId);
		if (result.status !== 0)
			throw new Error(
				`Hermes official Skill uninstall failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
			);
		if (existsSync(target))
			throw new Error("Hermes official Skill uninstall did not remove the Skill target");
		rmSync(receipt.path, { force: true });
		return "removed";
	},
	cleanupManifestOwned(input) {
		const target = targetDir(input.home, input.skillId);
		const receipt = receiptInput(input.home, input.skillId, input.ownershipIdentity);
		if (!existsSync(target)) {
			rmSync(receipt.path, { force: true });
			return "absent";
		}
		if (!managedSkillReceiptMatchesIdentity(receipt)) {
			throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
		}
		withRuntimeUserFileAccess(() => rmSync(target, { recursive: true }));
		rmSync(receipt.path, { force: true });
		return "removed";
	},
};
