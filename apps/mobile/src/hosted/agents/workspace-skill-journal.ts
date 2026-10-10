import type { WorkspaceSkillMutation } from "@clawdi/shared/api";
import {
	type createSkillAttemptStore,
	type SkillAttempt,
	skillAttemptAfterFailure,
} from "@/platform/skill-attempt";

type SkillAttemptStore = ReturnType<typeof createSkillAttemptStore>;

/** A confirmed change: its key is the idempotency key for the first send and every Retry. */
export function newSkillAttempt(
	deploymentId: string,
	resourceVersion: string,
	mutation: WorkspaceSkillMutation,
	key: string,
): SkillAttempt {
	return { format: 1, deploymentId, version: resourceVersion, key, mutation, status: "prepared" };
}

/**
 * Sequences one deployment's journaled workspace Skill changes. The caller supplies the
 * request and its account/foreground guards; `onJournal` mirrors each journal write.
 */
export function createWorkspaceSkillJournal(store: SkillAttemptStore) {
	// Bumped when a write starts and ends, so a read overlapping any write is reported stale.
	let revision = 0;
	let writing = 0;
	const write = async <T>(run: () => Promise<T>): Promise<T> => {
		revision += 1;
		writing += 1;
		try {
			return await run();
		} finally {
			writing -= 1;
			revision += 1;
		}
	};
	return {
		/** A stale result must not replace the journal state the overlapping write reported. */
		read: async (key: string, deploymentId: string) => {
			const start = revision;
			const attempt = await store.readSavedAttempt(key);
			if (attempt && attempt.deploymentId !== deploymentId) throw new Error("Wrong saved request");
			return { attempt, stale: writing > 0 || start !== revision };
		},
		/**
		 * Journals the attempt before sending it and clears it once accepted. A definitive
		 * failure settles the journal; an uncertain one rethrows and keeps it for Retry/Discard.
		 */
		send: (
			attempt: SkillAttempt,
			{
				key,
				fresh,
				apply,
				owns,
				visible,
				onJournal,
			}: {
				key: string;
				fresh: boolean;
				apply: (attempt: SkillAttempt) => Promise<unknown>;
				owns: () => boolean;
				visible: () => boolean;
				onJournal: (attempt: SkillAttempt | null) => void;
			},
		) =>
			write(async (): Promise<"accepted" | "settled" | "stopped"> => {
				if (fresh) await store.saveAttempt(key, attempt, owns);
				if (!owns()) return "stopped";
				onJournal(attempt);
				const sending: SkillAttempt = { ...attempt, status: "uncertain" };
				await store.replaceAttempt(key, attempt, sending, () => owns() && visible());
				if (!owns()) return "stopped";
				onJournal(sending);
				if (!visible()) return "stopped";
				try {
					await apply(attempt);
					if (!owns()) return "stopped";
					await store.clearAttempt(key, sending, owns);
					if (!owns()) return "stopped";
					onJournal(null);
					return "accepted";
				} catch (error) {
					const settled = skillAttemptAfterFailure(attempt, error);
					if (!owns() || settled.status === "uncertain") throw error;
					// The saved request's status copy or its rejection reason explains a resolved failure.
					await store.replaceAttempt(key, sending, settled, owns);
					if (!owns()) return "stopped";
					onJournal(settled);
					return "settled";
				}
			}),
		discard: (key: string, attempt: SkillAttempt, owns: () => boolean) =>
			write(() => store.clearAttempt(key, attempt, owns)),
	};
}
