import {
	ApiClientError,
	deploymentMutationHeaders,
	type WorkspaceSkillMutation,
} from "@clawdi/shared/api";
import { workspaceSkillErrorMessage } from "@clawdi/shared/view";
import { type AttemptStore, createSerializedAttemptStore } from "@/platform/attempt-store";

export type SkillAttempt = {
	format: 1;
	deploymentId: string;
	key: string;
	version: string;
	mutation: WorkspaceSkillMutation;
	status: "prepared" | "uncertain" | "rejected";
};
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseSkillAttempt(raw: string): SkillAttempt | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!record(value) ||
			value.format !== 1 ||
			typeof value.deploymentId !== "string" ||
			!value.deploymentId ||
			typeof value.key !== "string" ||
			typeof value.version !== "string" ||
			!record(value.mutation)
		)
			return null;
		deploymentMutationHeaders(value.version, value.key);
		const item = value.mutation;
		let mutation: WorkspaceSkillMutation;
		if (
			item.action === "install" &&
			record(item.request) &&
			typeof item.request.repo === "string" &&
			item.request.repo &&
			(item.request.path === undefined ||
				item.request.path === null ||
				typeof item.request.path === "string")
		) {
			mutation = {
				action: "install",
				request: {
					repo: item.request.repo,
					...(item.request.path === undefined ? {} : { path: item.request.path }),
				},
			};
		} else if (
			item.action === "uninstall" &&
			typeof item.skillKey === "string" &&
			item.skillKey &&
			item.skillKey !== "clawdi"
		)
			mutation = { action: "uninstall", skillKey: item.skillKey };
		else return null;
		if (JSON.stringify(mutation) !== JSON.stringify(item)) return null;
		if (value.status !== "prepared" && value.status !== "uncertain" && value.status !== "rejected")
			return null;
		if (
			Object.keys(value).some(
				(key) => !["format", "deploymentId", "key", "version", "mutation", "status"].includes(key),
			)
		)
			return null;
		return {
			format: 1,
			deploymentId: value.deploymentId,
			key: value.key,
			version: value.version,
			mutation,
			status: value.status,
		};
	} catch {
		return null;
	}
}
export function createSkillAttemptStore(store: AttemptStore) {
	return createSerializedAttemptStore(store, {
		parse: parseSkillAttempt,
		ownerError: "Skill owner changed",
		sameIntent: (a, b) =>
			a.deploymentId === b.deploymentId &&
			a.key === b.key &&
			a.version === b.version &&
			JSON.stringify(a.mutation) === JSON.stringify(b.mutation),
	});
}

const sourceRejections: Partial<Record<number, string[]>> = {
	412: ["resource_version_mismatch"],
	400: ["workspace_skill_source_invalid"],
	404: ["workspace_skill_source_invalid"],
	409: [
		"workspace_skills_capability_unavailable",
		"workspace_skill_source_conflict",
		"workspace_skill_reserved",
	],
};

/** Hosted keeps a request's receipt for 24 h and answers a replay from it before any of
 * these checks, so within that window each of them proves the change was not applied.
 * After 24 h, a 412 or capability_unavailable can follow an applied change whose receipt
 * expired; the request still can't be replayed, so it settles as rejected and the copy never
 * claims nothing was applied. Source errors are raised after If-Match passed, so nothing
 * changed since the saved version at any age, and an unavailable source may be sent again.
 */
export function skillAttemptAfterFailure(attempt: SkillAttempt, error: unknown): SkillAttempt {
	let status: SkillAttempt["status"] = "uncertain";
	if (error instanceof ApiClientError) {
		if (error.status === 503 && error.code === "workspace_skill_source_unavailable")
			status = "prepared";
		else if (sourceRejections[error.status]?.includes(error.code ?? "")) status = "rejected";
	}
	return { ...attempt, status };
}

/** The reason shown for a rejected request. A 412 only says the Skills changed, so it keeps
 * the conflict copy; the reason is unknown once the error is gone (e.g. after a restart).
 */
export function skillRejectionReason(attempt: SkillAttempt, error: unknown): string | null {
	if (attempt.status !== "rejected" || !(error instanceof ApiClientError)) return null;
	return workspaceSkillErrorMessage(error.code);
}
