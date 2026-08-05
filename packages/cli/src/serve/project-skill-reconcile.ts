import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { components } from "@clawdi/shared/api";
import type { AgentAdapter } from "../adapters/base";
import { type ApiClient, unwrap } from "../lib/api-client";
import { readBoundedResponseBytes } from "../lib/github-skill-archive";
import {
	commitProjectSkillMaterialization,
	computeSkillFolderHash,
	hasExactProjectSkillMaterialization,
	type ProjectSkillMaterialization,
	readProjectSkillMaterialization,
	readProjectSkillMaterializationsForReconcile,
	recordProjectSkillMaterialization,
	removeExactProjectSkillMaterialization,
} from "../lib/skills-lock";
import { extractTarGz, snapshotSkillArchive } from "../lib/tar";

type DesiredInventory = components["schemas"]["AgentProjectSkillDesiredResponse"];
type DesiredSkill = components["schemas"]["AgentProjectSkillDesiredItem"];

const MAX_PROJECT_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;

type MaterializationInput = {
	agentType: string;
	localSkillKey: string;
	sourceProjectId: string;
	sourceSkillKey: string;
	contentHash: string;
	reconcileAgentId: string;
};

type PriorMaterialization = {
	input: MaterializationInput;
	archive: Buffer;
};

function desiredInput(
	agentType: string,
	agentId: string,
	desired: DesiredSkill,
): MaterializationInput {
	return {
		agentType,
		localSkillKey: desired.skill_key,
		sourceProjectId: desired.project_id,
		sourceSkillKey: desired.skill_key,
		contentHash: desired.content_hash,
		reconcileAgentId: agentId,
	};
}

function priorInput(
	agentType: string,
	agentId: string,
	receipt: ProjectSkillMaterialization,
): MaterializationInput {
	return {
		agentType,
		localSkillKey: receipt.local_skill_key,
		sourceProjectId: receipt.source_project_id,
		sourceSkillKey: receipt.source_skill_key,
		contentHash: receipt.content_hash,
		reconcileAgentId: agentId,
	};
}

async function snapshotOwnedTarget(
	adapter: Pick<AgentAdapter, "getSkillPath">,
	input: MaterializationInput,
): Promise<Buffer> {
	const directory = dirname(adapter.getSkillPath(input.localSkillKey));
	if (!existsSync(join(directory, "SKILL.md"))) {
		throw new Error(`Project Skill ${input.localSkillKey} is missing from this Agent`);
	}
	const snapshot = await snapshotSkillArchive(directory, undefined, input.localSkillKey);
	if (snapshot.hash !== input.contentHash) {
		throw new Error(
			`Project Skill ${input.localSkillKey} was changed locally. Move or rename it, then try again.`,
		);
	}
	return snapshot.archive;
}

function assertArchiveUrl(api: ApiClient, agentId: string, desired: DesiredSkill): URL {
	const url = new URL(desired.archive_url);
	if (url.origin !== new URL(api.baseUrl).origin || url.search || url.hash) {
		throw new Error(`Project Skill ${desired.skill_key} has an invalid download address`);
	}
	const prefix = `/v1/runtime/project-skill-archives/${agentId}/${desired.project_id}/${desired.skill_id}/${desired.content_hash}/`;
	if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(`/${desired.skill_key}.tar.gz`)) {
		throw new Error(`Project Skill ${desired.skill_key} has an invalid download identity`);
	}
	return url;
}

async function downloadDesiredArchive(
	api: ApiClient,
	agentId: string,
	desired: DesiredSkill,
): Promise<Buffer> {
	const response = await fetch(assertArchiveUrl(api, agentId, desired), {
		headers: {
			Authorization: `Bearer ${await api.getAccessToken()}`,
			Accept: "application/gzip",
		},
		redirect: "error",
	});
	if (!response.ok) {
		throw new Error(`Project Skill ${desired.skill_key} download failed (${response.status})`);
	}
	const bytes = await readBoundedResponseBytes(response, MAX_PROJECT_SKILL_ARCHIVE_BYTES, {
		resourceLabel: "Project Skill archive",
		limitLabel: "25 MB",
	});
	const stage = await mkdtemp(join(tmpdir(), "clawdi-project-reconcile-"));
	try {
		await extractTarGz(stage, bytes);
		const directory = join(stage, desired.skill_key);
		if (!existsSync(join(directory, "SKILL.md"))) {
			throw new Error(`Project Skill ${desired.skill_key} archive is invalid`);
		}
		const canonical = await snapshotSkillArchive(directory, stage, desired.skill_key);
		if (canonical.hash !== desired.content_hash) {
			throw new Error(`Project Skill ${desired.skill_key} download failed its identity check`);
		}
		return canonical.archive;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

export async function reconcileConnectedProjectSkills(input: {
	api: ApiClient;
	agentId: string;
	adapter: Pick<
		AgentAdapter,
		"agentType" | "getSkillPath" | "listSkillKeys" | "writeSkillArchive" | "removeLocalSkill"
	>;
}): Promise<void> {
	unwrap(
		await input.api.PUT("/v1/runtime/project-skill-capability", {
			params: { query: { environment_id: input.agentId } },
			body: { project_skill_reconcile_version: 1 },
		}),
	);
	const response = unwrap(
		await input.api.GET("/v1/runtime/project-skills", {
			params: { query: { environment_id: input.agentId } },
		}),
	) as DesiredInventory;
	if (response.agent_id !== input.agentId)
		throw new Error("Project Skill inventory Agent mismatch");
	const desiredByKey = new Map<string, DesiredSkill>();
	for (const desired of response.skills ?? []) {
		if (desiredByKey.has(desired.skill_key)) {
			throw new Error(`Skill ${desired.skill_key} comes from more than one linked Project`);
		}
		desiredByKey.set(desired.skill_key, desired);
	}

	const localKeys = new Set(await input.adapter.listSkillKeys());
	const ownedReceipts = readProjectSkillMaterializationsForReconcile(
		input.adapter.agentType,
		input.agentId,
	);
	const priorByKey = new Map<string, PriorMaterialization>();
	const missingOwnedKeys = new Set<string>();
	for (const receipt of ownedReceipts) {
		const receiptInput = priorInput(input.adapter.agentType, input.agentId, receipt);
		if (!existsSync(input.adapter.getSkillPath(receipt.local_skill_key))) {
			missingOwnedKeys.add(receipt.local_skill_key);
			continue;
		}
		priorByKey.set(receipt.local_skill_key, {
			input: receiptInput,
			archive: await snapshotOwnedTarget(input.adapter, receiptInput),
		});
	}

	const downloads = new Map<string, Buffer>();
	for (const desired of [...desiredByKey.values()].sort((a, b) =>
		a.skill_key.localeCompare(b.skill_key),
	)) {
		const next = desiredInput(input.adapter.agentType, input.agentId, desired);
		const receipt = readProjectSkillMaterialization({
			agentType: input.adapter.agentType,
			localSkillKey: desired.skill_key,
		});
		if (!receipt && localKeys.has(desired.skill_key)) {
			throw new Error(
				`Skill ${desired.skill_key} already exists in this Agent's Workspace. Move or rename it, then try again.`,
			);
		}
		if (receipt && receipt.reconcile_agent_id !== input.agentId) {
			throw new Error(
				`Skill ${desired.skill_key} already exists in this Agent's Workspace. Move or rename it, then try again.`,
			);
		}
		if (!missingOwnedKeys.has(desired.skill_key) && hasExactProjectSkillMaterialization(next)) {
			continue;
		}
		downloads.set(
			desired.skill_key,
			await downloadDesiredArchive(input.api, input.agentId, desired),
		);
	}
	for (const receipt of ownedReceipts) {
		if (!missingOwnedKeys.has(receipt.local_skill_key)) continue;
		removeExactProjectSkillMaterialization(
			priorInput(input.adapter.agentType, input.agentId, receipt),
		);
	}

	const applied: Array<
		| { kind: "installed"; input: MaterializationInput; prior?: PriorMaterialization }
		| { kind: "removed"; prior: PriorMaterialization }
	> = [];
	try {
		for (const [skillKey, archive] of [...downloads].sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			const desired = desiredByKey.get(skillKey);
			if (!desired) throw new Error("Project Skill inventory changed during reconcile");
			const next = desiredInput(input.adapter.agentType, input.agentId, desired);
			const prior = priorByKey.get(skillKey);
			await commitProjectSkillMaterialization(next, () =>
				input.adapter.writeSkillArchive(skillKey, archive),
			);
			applied.push({ kind: "installed", input: next, ...(prior ? { prior } : {}) });
			const installedHash = await computeSkillFolderHash(
				dirname(input.adapter.getSkillPath(skillKey)),
				undefined,
				skillKey,
			);
			if (installedHash !== desired.content_hash) {
				throw new Error(`Project Skill ${skillKey} did not install with the expected content`);
			}
		}
		for (const prior of [...priorByKey.values()].sort((a, b) =>
			a.input.localSkillKey.localeCompare(b.input.localSkillKey),
		)) {
			if (desiredByKey.has(prior.input.localSkillKey)) continue;
			await input.adapter.removeLocalSkill(prior.input.localSkillKey);
			applied.push({ kind: "removed", prior });
			if (!removeExactProjectSkillMaterialization(prior.input)) {
				throw new Error(
					`Project Skill ${prior.input.localSkillKey} ownership changed during reconcile`,
				);
			}
		}
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const operation of applied.reverse()) {
			try {
				if (operation.kind === "removed") {
					await input.adapter.writeSkillArchive(
						operation.prior.input.localSkillKey,
						operation.prior.archive,
					);
					recordProjectSkillMaterialization(operation.prior.input);
				} else if (operation.prior) {
					await input.adapter.writeSkillArchive(
						operation.prior.input.localSkillKey,
						operation.prior.archive,
					);
					recordProjectSkillMaterialization(operation.prior.input);
				} else {
					await input.adapter.removeLocalSkill(operation.input.localSkillKey);
					removeExactProjectSkillMaterialization(operation.input);
				}
			} catch (rollbackError) {
				rollbackErrors.push(
					rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
				);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new Error(
				`Project Skill update failed and rollback needs attention: ${rollbackErrors.join("; ")}`,
				{ cause: error },
			);
		}
		throw error;
	}
}
