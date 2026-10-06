import {
	ApiClientError,
	deploymentMutationHeaders,
	type WorkspaceSkillMutation,
} from "@clawdi/shared/api";
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

export function skillAttemptAfterFailure(attempt: SkillAttempt, error: unknown): SkillAttempt {
	const preflight =
		error instanceof ApiClientError &&
		((error.status === 412 && error.code === "resource_version_mismatch") ||
			(error.status === 400 && error.code === "workspace_skill_source_invalid") ||
			(error.status === 409 &&
				[
					"workspace_skills_capability_unavailable",
					"workspace_skill_source_conflict",
					"workspace_skill_reserved",
				].includes(error.code ?? "")));
	return {
		...attempt,
		status: attempt.status === "prepared" && preflight ? "rejected" : "uncertain",
	};
}
