import {
	type DeployComponents,
	type WorkspaceSkillMutation,
	workspaceSkillMutationsAvailable,
} from "@clawdi/shared/api";
import { agentSurfaceCopy } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentConfirmation } from "@/components/dashboard/confirmation";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { skillsRefetchPolicy } from "@/hosted/agents/agent-desired-skills-query";
import {
	createWorkspaceSkillJournal,
	newSkillAttempt,
} from "@/hosted/agents/workspace-skill-journal";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { type SkillAttempt, skillRejectionReason } from "@/platform/skill-attempt";
import { skillAttempts } from "@/platform/skill-attempt-storage";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/**
 * Journaled hosted workspace Skill changes for one deployment: the install sheet and the Agent
 * Skills list share the saved attempt, its Retry/Discard recovery and the confirmation.
 */
export function useWorkspaceSkillChanges(
	id: string,
	{ onAccepted }: { onAccepted?: () => Promise<unknown> } = {},
) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const { workspaceSkills: client, hosted } = useMobileApi();
	const cache = useQueryClient();
	const [saved, setSaved] = useState<SkillAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storageError, setStorageError] = useState(false);
	const [epoch, setEpoch] = useState(0);
	const focused = useIsFocused();
	const [accepted, setAccepted] = useState(false);
	const [journalStore] = useState(() => createWorkspaceSkillJournal(skillAttempts));
	const confirmation = useRef(0);
	const inventory = useQuery<DeployComponents["schemas"]["V2WorkspaceSkillListResponse"]>({
		queryKey: accountQueryKey(scope, "workspace-skills", id),
		// Keeps deployment_resource_version current, so a change rarely starts from a stale version.
		...skillsRefetchPolicy(focused),
		enabled: Boolean(id && client && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!client) throw new Error(agentSurfaceCopy.unavailable);
				return client.list(id, lease);
			}, signal),
	});
	const deployment = useQuery({
		queryKey: accountQueryKey(scope, "workspace-skills-deployment", id),
		enabled: Boolean(id && hosted && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!hosted) throw new Error(agentSurfaceCopy.unavailable);
				return hosted.getDeployment(id, lease);
			}, signal),
	});
	// Reread on focus too: the install sheet and the Skills list share this deployment's journal.
	useEffect(() => {
		let mounted = true;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
		if (!focused) return;
		setStorageKey(null);
		setStorageError(false);
		void (async () => {
			try {
				if (!scope.accountKey || !id || !scope.isReady) return;
				const digest = await digestStringAsync(
					CryptoDigestAlgorithm.SHA256,
					JSON.stringify([scope.accountKey, id]),
				);
				if (!current()) return;
				const key = `clawdi.workspace-skills.v1.${digest}`;
				const { attempt, stale } = await journalStore.read(key, id);
				if (!current()) return;
				// A change journaled during this read already reported the newer state.
				if (!stale) setSaved(attempt);
				setStorageKey(key);
			} catch {
				if (current()) setStorageError(true);
			}
		})();
		return () => {
			mounted = false;
		};
	}, [scope, id, epoch, focused, journalStore]);
	const enabled =
		!action.busy &&
		!saved &&
		!storageError &&
		Boolean(storageKey) &&
		scope.isReady &&
		inventory.data?.deployment_id === id &&
		workspaceSkillMutationsAvailable(inventory.data, inventory.error) &&
		!deployment.isError &&
		deployment.data?.resource.id === id &&
		deployment.data.resource.spec.desired_lifecycle !== "deleted";
	const refresh = async () => {
		await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	};
	const submit = (attempt: SkillAttempt, fresh = false) =>
		action.run(async (current) => {
			if (!client || !storageKey || storageError || attempt.status === "rejected") return;
			const visible = capture();
			const owns = () => current() && scope.isCurrent() && !scope.signal.aborted;
			if (!visible()) return;
			setAccepted(false);
			const outcome = await journalStore.send(attempt, {
				key: storageKey,
				fresh,
				owns,
				visible,
				onJournal: setSaved,
				apply: (sent) =>
					read((signal) => client.apply(id, sent.version, sent.key, sent.mutation, signal)),
			});
			if (outcome === "accepted") {
				setAccepted(true);
				await refresh();
				if (onAccepted && owns()) await onAccepted();
			} else if (outcome === "settled") await refresh();
		});
	const confirm = (
		title: string,
		message: string,
		confirmLabel: string,
		run: () => unknown,
		destructive: boolean,
	) => {
		const ticket = ++confirmation.current;
		const visible = capture();
		confirmationDialog.request({
			title,
			description: message,
			confirmLabel,
			destructive,
			onConfirm: () => {
				if (
					ticket !== confirmation.current ||
					!scope.isCurrent() ||
					scope.signal.aborted ||
					!visible()
				)
					return;
				return run();
			},
		});
	};
	/** `name` labels an uninstall confirmation; it defaults to the Skill key. */
	const prepare = (mutation: WorkspaceSkillMutation, name?: string) => {
		if (!enabled || !inventory.data) return;
		const attempt = newSkillAttempt(
			id,
			inventory.data.deployment_resource_version,
			mutation,
			randomUUID(),
		);
		// Failures close the confirmation: the journaled attempt's Retry/Discard controls drive
		// recovery, since repeating a fresh save over that journal can only fail.
		if (mutation.action === "install")
			confirm(
				t("workspaceSkills.confirm"),
				t("workspaceSkills.warning"),
				agentSurfaceCopy.installSkill,
				() => submit(attempt, true),
				false,
			);
		else
			confirm(
				t("agentExtensions.uninstallTitle", { name: name ?? mutation.skillKey }),
				t("agentExtensions.uninstallWarning"),
				t("agentExtensions.uninstallConfirm"),
				() => submit(attempt, true),
				true,
			);
	};
	const reason = saved?.status === "rejected" ? skillRejectionReason(saved.rejectionCode) : null;
	const journal = (
		<>
			{saved ? (
				<>
					{reason ? (
						<ApiErrorPanel
							error={saved.rejectionCode}
							title={t("workspaceSkills.updateError")}
							normalizer={{ isAuthError: () => false, normalizeError: () => reason }}
						/>
					) : (
						<AppText>
							{t(
								saved.status === "rejected"
									? "workspaceSkills.conflict"
									: saved.status === "prepared"
										? "workspaceSkills.notApplied"
										: "workspaceSkills.uncertain",
							)}
						</AppText>
					)}
					<AppText selectable>
						{saved.mutation.action === "install"
							? `${saved.mutation.request.repo}/${saved.mutation.request.path ?? ""}`
							: saved.mutation.skillKey}
					</AppText>
					<ActionButton
						label={t("workspaceSkills.retry")}
						disabled={
							action.busy || storageError || !storageKey || !client || saved.status === "rejected"
						}
						onPress={() => void submit(saved)}
					/>
					<ActionButton
						label={t("workspaceSkills.discard")}
						disabled={action.busy || storageError}
						onPress={() =>
							confirm(
								t("workspaceSkills.discard"),
								t(
									saved.status === "uncertain"
										? "workspaceSkills.discardUncertainWarning"
										: "workspaceSkills.discardWarning",
								),
								t("workspaceSkills.discard"),
								() =>
									action.runOrThrow(async (current) => {
										if (!storageKey) return;
										await journalStore.discard(
											storageKey,
											saved,
											() => current() && scope.isCurrent(),
										);
										if (current()) {
											setSaved(null);
											await refresh();
										}
									}),
								true,
							)
						}
					/>
				</>
			) : null}
			{storageError ? (
				<AppText accessibilityRole="alert">{t("workspaceSkills.storageError")}</AppText>
			) : null}
			{saved || storageError ? (
				<ActionButton
					label={t("workspaceSkills.reload")}
					disabled={action.busy}
					onPress={() => setEpoch((value) => value + 1)}
				/>
			) : null}
			{accepted ? (
				<AppText accessibilityRole="alert">{t("workspaceSkills.accepted")}</AppText>
			) : null}
			{action.error ? (
				<AppText accessibilityRole="alert">{t("workspaceSkills.error")}</AppText>
			) : null}
		</>
	);
	return {
		inventory,
		deployment,
		enabled,
		busy: action.busy,
		journaled: saved !== null,
		prepare,
		journal,
		dialog: confirmationDialog.dialog,
	};
}
