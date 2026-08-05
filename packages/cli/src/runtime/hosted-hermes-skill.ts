import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PreparedHostedCatalogSkill } from "./hosted-catalog-skill-archive";
import {
	collectManagedSkillTree,
	managedSkillReceiptMatchesIdentity,
	managedSkillReceiptOwnsTarget,
	managedSkillTreesEqual,
	withManagedTargetRollback,
	withStagedManagedSkill,
	writeManagedSkillReceipt,
} from "./managed-skill-delivery";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";

const RECEIPT_SCHEMA = "clawdi.hermesManifestSkillReceipt.v2";

export interface HostedHermesSkillExactSourceDriver {
	install(input: {
		home: string;
		appRoot: string;
		skill: PreparedHostedCatalogSkill;
		previouslyReserved: boolean;
	}): "installed" | "unchanged";
	verifyOwned(input: { home: string; appRoot: string; skill: PreparedHostedCatalogSkill }): boolean;
	uninstall(input: {
		home: string;
		appRoot: string;
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

function rawSkillUrl(skill: PreparedHostedCatalogSkill): string {
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

function runHermes(input: { home: string; appRoot: string }, args: string[]) {
	return spawnRuntimeUserCommand(
		commandPath(input.home, input.appRoot),
		args,
		input.home,
		input.appRoot,
		{
			hermesHome: join(input.home, ".hermes"),
			timeoutMs: 120_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
}

const HERMES_SUPPORT_DIRS = new Set(["references", "templates", "scripts", "assets", "examples"]);
const HERMES_SUPPORT_REFERENCE =
	/(?:\]\(|`|(?:^|[\s"']))((?:references|templates|scripts|assets|examples)\/[^\s)`"'<>]+)/gm;

/** Mirrors Hermes UrlSource at NousResearch/hermes-agent@aec3318: SKILL.md plus allowlisted references. */
function expectedHermesNativeTree(sourceDir: string) {
	const catalogTree = collectManagedSkillTree(sourceDir);
	const skillMd = catalogTree?.get("SKILL.md");
	if (!catalogTree || !skillMd) return null;
	const text = skillMd.toString("utf8").replaceAll("\\", "/");
	if (
		/(?:references|templates|scripts|assets|examples)\/(?:[^\s)`"'<>]*\/)?\.\.(?:\/|$)/m.test(text)
	)
		return null;
	const expected = new Map<string, Buffer>([["SKILL.md", skillMd]]);
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

function nativeResultMatches(sourceDir: string, target: string): boolean {
	return managedSkillTreesEqual(
		expectedHermesNativeTree(sourceDir),
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
			if (nativeResultMatches(sourceDir, target) && managedSkillReceiptMatchesIdentity(receipt))
				return "unchanged";
			if (hadTarget && !managedSkillReceiptOwnsTarget(receipt))
				throw new Error(
					"refusing to replace a Hermes Skill without a matching Clawdi ownership receipt",
				);
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
						throw new Error(
							`Hermes official Skill install failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
						);
					if (!nativeResultMatches(sourceDir, target)) {
						if (!hadTarget) {
							const rollback = runHermes(input, [
								"skills",
								"uninstall",
								input.skill.skillId,
								"--yes",
							]);
							if (rollback.status !== 0)
								throw new Error(
									`Hermes official install produced invalid Skill bytes and native rollback failed: ${String(rollback.stderr || rollback.stdout).trim() || "unknown error"}`,
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
				nativeResultMatches(sourceDir, targetDir(input.home, input.skill.skillId)) &&
				managedSkillReceiptMatchesIdentity(
					receiptInput(input.home, input.skill.skillId, input.skill.sourceIdentity),
				),
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
		const result = runHermes(input, ["skills", "uninstall", input.skillId, "--yes"]);
		if (result.status !== 0)
			throw new Error(
				`Hermes official Skill uninstall failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
			);
		rmSync(receipt.path, { force: true });
		return "removed";
	},
};
