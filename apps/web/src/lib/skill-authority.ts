import type { components } from "@clawdi/shared/api";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type Project = components["schemas"]["ProjectResponse"];

export type SkillReadOnlyReason = "agent-sync" | "agent-project" | "shared" | "unknown";

export type SkillCapabilities = {
	canUpdate: boolean;
	canDelete: boolean;
	canSend: boolean;
	readOnlyReason: SkillReadOnlyReason | null;
	badgeLabel: string | null;
	provenanceLabel: string | null;
};

const WRITABLE_SKILL_CAPABILITIES: SkillCapabilities = {
	canUpdate: true,
	canDelete: true,
	canSend: true,
	readOnlyReason: null,
	badgeLabel: null,
	provenanceLabel: null,
};

function readOnlyCapabilities(
	reason: SkillReadOnlyReason,
	provenanceLabel: string | null,
): SkillCapabilities {
	return {
		canUpdate: false,
		canDelete: false,
		canSend: false,
		readOnlyReason: reason,
		badgeLabel: "Read-only",
		provenanceLabel,
	};
}

/**
 * Browser capabilities are derived from persisted provenance plus Project kind.
 * The backend remains the enforcement boundary; this helper keeps every Web
 * entry point consistent and fails closed while Project metadata is missing.
 */
export function skillCapabilities(
	skill: Pick<SkillSummary, "authority" | "project_id" | "project_kind">,
	project: Pick<Project, "kind" | "is_owner"> | null | undefined,
): SkillCapabilities {
	if (skill.authority === "agent_sync") {
		return readOnlyCapabilities("agent-sync", "Synced from Agent");
	}
	const projectKind = skill.project_kind ?? project?.kind;
	if (projectKind === "environment") {
		return readOnlyCapabilities("agent-project", "Agent Workspace");
	}
	if (!skill.project_id || project === undefined || project === null) {
		return readOnlyCapabilities("unknown", null);
	}
	if (project.is_owner === false) {
		return readOnlyCapabilities("shared", "Shared Project");
	}
	return WRITABLE_SKILL_CAPABILITIES;
}

export function isBrowserWritableSkillProject(
	project: Pick<Project, "kind" | "is_owner"> | null | undefined,
): boolean {
	return Boolean(project && project.kind !== "environment" && project.is_owner !== false);
}
