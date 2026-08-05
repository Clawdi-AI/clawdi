import type { components } from "@clawdi/shared/api";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type Project = components["schemas"]["ProjectResponse"];

export type SkillReadOnlyReason = "agent-sync" | "agent-project" | "shared" | "unknown";

export type SkillCapabilities = {
	canUpdate: boolean;
	canDelete: boolean;
	canSend: boolean;
	canSelect: boolean;
	canSync: boolean;
	readOnlyReason: SkillReadOnlyReason | null;
	badgeLabel: string | null;
};

const WRITABLE_SKILL_CAPABILITIES: SkillCapabilities = {
	canUpdate: true,
	canDelete: true,
	canSend: true,
	canSelect: true,
	canSync: true,
	readOnlyReason: null,
	badgeLabel: null,
};

function readOnlyCapabilities(reason: SkillReadOnlyReason, badgeLabel: string): SkillCapabilities {
	return {
		canUpdate: false,
		canDelete: false,
		canSend: false,
		canSelect: false,
		canSync: false,
		readOnlyReason: reason,
		badgeLabel,
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
		return readOnlyCapabilities("agent-sync", "Synced from Agent · Read-only");
	}
	const projectKind = skill.project_kind ?? project?.kind;
	if (projectKind === "environment") {
		return readOnlyCapabilities("agent-project", "Workspace · Read-only");
	}
	if (!skill.project_id || project === undefined || project === null) {
		return readOnlyCapabilities("unknown", "Read-only");
	}
	if (project.is_owner === false) {
		return readOnlyCapabilities("shared", "Shared · Read-only");
	}
	return WRITABLE_SKILL_CAPABILITIES;
}

export function isBrowserWritableSkillProject(
	project: Pick<Project, "kind" | "is_owner"> | null | undefined,
): boolean {
	return Boolean(project && project.kind !== "environment" && project.is_owner !== false);
}
