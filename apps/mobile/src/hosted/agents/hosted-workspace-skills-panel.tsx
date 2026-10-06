import {
	type DeployComponents,
	parseWorkspaceSkillGitHubInput,
	type WorkspaceSkillMutation,
	workspaceSkillMutationsAvailable,
} from "@clawdi/shared/api";
import { HERO_GRID_CLASS } from "@clawdi/shared/ui";
import { agentSurfaceCopy, identityFor, workspaceSkillInstallCopy } from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { useAgentConfirmation } from "@/components/dashboard/confirmation";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Input as AppTextInput, Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebView } from "@/components/ui/web-layout";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { canPollDeployment } from "@/hosted/deployment-status";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { useSheet } from "@/platform/navigation/use-sheet";
import { type SkillAttempt, skillAttemptAfterFailure } from "@/platform/skill-attempt";
import { skillAttempts } from "@/platform/skill-attempt-storage";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function WorkspaceSkillsScreen({
	deploymentId,
	install = false,
}: {
	deploymentId?: string;
	install?: boolean;
}) {
	const params = useLocalSearchParams<{ deploymentId?: string | string[] }>();
	const id = deploymentId ?? routeParam(params.deploymentId) ?? "";
	const scope = useAccountScope();
	return (
		<WorkspaceSkills
			key={`${scope.accountKey}:${scope.generation}:${id}`}
			id={id}
			install={install}
		/>
	);
}

function WorkspaceSkills({ id, install }: { id: string; install: boolean }) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const { workspaceSkills: client, hosted } = useMobileApi();
	const cache = useQueryClient();
	const [source, setSource] = useState("");
	const [saved, setSaved] = useState<SkillAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storageError, setStorageError] = useState(false);
	const [epoch, setEpoch] = useState(0);
	const focused = useIsFocused();
	const [startedAt, setStartedAt] = useState(Date.now);
	const [accepted, setAccepted] = useState(false);
	const confirmation = useRef(0);
	const inventory = useQuery<DeployComponents["schemas"]["V2WorkspaceSkillListResponse"]>({
		queryKey: accountQueryKey(scope, "workspace-skills", id),
		refetchInterval: (query) =>
			focused &&
			!query.state.error &&
			query.state.data?.items?.some((item) => item.status === "requested") &&
			canPollDeployment(startedAt, Date.now(), focusManager.isFocused(), onlineManager.isOnline())
				? 3000
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
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
	const installSheet = useSheet<boolean>({
		fallback: deployment.data?.agent_id
			? `/agents/${deployment.data.agent_id}/skills?tab=workspace`
			: "/agents",
		busy: install && action.busy,
	});
	useEffect(() => {
		let mounted = true;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
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
				const attempt = await skillAttempts.readSavedAttempt(key);
				if (!current()) return;
				if (attempt && attempt.deploymentId !== id) throw new Error("Wrong saved request");
				setSaved(attempt);
				setStorageKey(key);
			} catch {
				if (current()) setStorageError(true);
			}
		})();
		return () => {
			mounted = false;
		};
	}, [scope, id, epoch]);
	const enabled =
		!action.busy &&
		!saved &&
		!storageError &&
		Boolean(storageKey) &&
		scope.isReady &&
		inventory.data?.deployment_id === id &&
		workspaceSkillMutationsAvailable(inventory.data, inventory.error) &&
		!inventory.isFetching &&
		!deployment.isError &&
		deployment.data?.resource.id === id &&
		deployment.data.resource.spec.desired_lifecycle !== "deleted";
	const refresh = async () => {
		await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	};
	const submit = (attempt: SkillAttempt, fresh = false, guarded = false) =>
		(guarded ? action.runOrThrow : action.run)(async (current) => {
			if (!client || !storageKey || storageError || attempt.status === "rejected") return;
			const visible = capture();
			const owns = () => current() && scope.isCurrent() && !scope.signal.aborted;
			if (!visible()) return;
			setAccepted(false);
			if (fresh) await skillAttempts.saveAttempt(storageKey, attempt, owns);
			if (!owns()) return;
			setSaved(attempt);
			const sending: SkillAttempt = { ...attempt, status: "uncertain" };
			await skillAttempts.replaceAttempt(storageKey, attempt, sending, () => owns() && visible());
			if (!owns()) return;
			setSaved(sending);
			if (!visible()) return;
			try {
				await read((signal) =>
					client.apply(id, attempt.version, attempt.key, attempt.mutation, signal),
				);
				if (!owns()) return;
				await skillAttempts.clearAttempt(storageKey, sending, owns);
				if (!owns()) return;
				setSaved(null);
				setAccepted(true);
				setStartedAt(Date.now());
				await refresh();
				if (install && owns()) await installSheet.close(true);
			} catch (error) {
				const rejected = skillAttemptAfterFailure(attempt, error);
				if (owns() && rejected.status === "rejected") {
					await skillAttempts.replaceAttempt(storageKey, sending, rejected, owns);
					if (owns()) setSaved(rejected);
				}
				throw error;
			}
		});
	const confirm = (label: string, message: string, run: () => unknown) => {
		const ticket = ++confirmation.current;
		const visible = capture();
		confirmationDialog.request({
			title: label,
			description: message,
			confirmLabel: label,
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
	const prepare = (mutation: WorkspaceSkillMutation) => {
		if (!enabled || !inventory.data) return;
		const attempt: SkillAttempt = {
			format: 1,
			deploymentId: id,
			version: inventory.data.deployment_resource_version,
			key: randomUUID(),
			mutation,
			status: "prepared",
		};
		confirm(t("workspaceSkills.confirm"), t("workspaceSkills.warning"), () =>
			submit(attempt, true, true),
		);
	};
	let installRequest: WorkspaceSkillMutation | null = null;
	try {
		installRequest = { action: "install", request: parseWorkspaceSkillGitHubInput(source) };
	} catch {
		/* Invalid drafts stay local. */
	}
	const form = (
		<AppView className="gap-3">
			{install && !enabled && !saved ? <AppText>{t("workspaceSkills.unavailable")}</AppText> : null}
			{install ? (
				<>
					<Label>{agentSurfaceCopy.gitHubSkillRepository}</Label>
					<AppTextInput
						value={source}
						onChangeText={setSource}
						editable={enabled}
						maxLength={2048}
						accessibilityLabel={t("workspaceSkills.source")}
						placeholder={t("workspaceSkills.source")}
					/>
					<ActionButton
						label={t("workspaceSkills.install")}
						disabled={!enabled || !installRequest}
						onPress={() => {
							if (installRequest) prepare(installRequest);
						}}
					/>
				</>
			) : null}
			{saved ? (
				<>
					<AppText>{t("workspaceSkills.uncertain")}</AppText>
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
					{saved.status !== "uncertain" ? (
						<ActionButton
							label={t("workspaceSkills.discard")}
							disabled={action.busy || storageError}
							onPress={() =>
								confirm(t("workspaceSkills.discard"), t("workspaceSkills.discardWarning"), () =>
									action.runOrThrow(async (current) => {
										if (!storageKey) return;
										await skillAttempts.clearAttempt(
											storageKey,
											saved,
											() => current() && scope.isCurrent(),
										);
										if (current()) {
											setSaved(null);
											await refresh();
										}
									}),
								)
							}
						/>
					) : null}
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
		</AppView>
	);
	if (install)
		return (
			<SheetPage
				title={workspaceSkillInstallCopy.title}
				description={workspaceSkillInstallCopy.description}
				busy={action.busy}
				sheet={installSheet}
				fallback={
					deployment.data?.agent_id
						? `/agents/${deployment.data.agent_id}/skills?tab=workspace`
						: "/agents"
				}
			>
				<NativeSegments
					value="github"
					options={[
						{ value: "library", label: workspaceSkillInstallCopy.library },
						{ value: "github", label: workspaceSkillInstallCopy.github },
					]}
					disabled={action.busy}
					onChange={(value) => {
						if (value === "library" && deployment.data?.agent_id)
							router.replace({
								pathname: "/agents/[id]/skills/browse",
								params: { id: deployment.data.agent_id },
							});
					}}
				/>
				{inventory.isError || deployment.isError ? (
					<ApiErrorPanel
						error={inventory.error ?? deployment.error}
						onRetry={() => {
							void inventory.refetch();
							void deployment.refetch();
						}}
					/>
				) : null}
				{form}
				{confirmationDialog.dialog}
			</SheetPage>
		);
	return (
		<AgentCollection
			title="Skills"
			description="Skills available in this Agent's Workspace."
			data={
				inventory.isError || deployment.isError || inventory.isPending
					? []
					: (inventory.data?.items ?? [])
			}
			keyExtractor={(item) => item.skill_key}
			refreshing={inventory.isRefetching}
			onRefresh={() => {
				setStartedAt(Date.now());
				void inventory.refetch();
				void deployment.refetch();
			}}
			renderItem={({ item }) => (
				<WorkspaceSkillItem
					agentId={deployment.data?.agent_id ?? ""}
					item={item}
					disabled={!enabled}
					onRemove={() => prepare({ action: "uninstall", skillKey: item.skill_key })}
				/>
			)}
			navigation={
				deployment.data?.agent_id ? (
					<AgentSectionNavigation agentId={deployment.data.agent_id} section="skills" />
				) : undefined
			}
		>
			<NativeHeader
				title="Skills"
				actions={[
					{
						id: "install",
						label: "Install skill",
						disabled: !deployment.data?.agent_id,
						onPress: () => {
							if (deployment.data?.agent_id)
								router.push({
									pathname: "/agents/[id]/skills/browse",
									params: { id: deployment.data.agent_id },
								});
						},
					},
				]}
			/>
			{form}

			{inventory.isError || deployment.isError ? (
				<ApiErrorPanel
					error={inventory.error ?? deployment.error}
					title="Couldn't load Skills"
					onRetry={() => {
						setStartedAt(Date.now());
						void inventory.refetch();
						void deployment.refetch();
					}}
				/>
			) : inventory.isPending ? (
				<WebView recipe={HERO_GRID_CLASS}>
					{[0, 1, 2].map((i) => (
						<HeroCardSkeleton key={i} />
					))}
				</WebView>
			) : !inventory.data?.items?.length ? (
				<EmptyState variant="inset" description="No Skills have synced from this Agent yet." />
			) : null}
			{confirmationDialog.dialog}
		</AgentCollection>
	);
}

function WorkspaceSkillItem({
	agentId,
	item,
	disabled,
	onRemove,
}: {
	agentId: string;
	item: DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"];
	disabled: boolean;
	onRemove: () => void;
}) {
	const t = useI18n(),
		identity = identityFor(item.skill_key);
	return (
		<HeroCard
			icon={
				<IconChip tint={identity.colorClasses}>
					<AppText>{identity.emoji}</AppText>
				</IconChip>
			}
			title={item.skill_key}
			footer={[t(`workspaceSkills.${item.status}`), item.source.url]}
			actions={
				<>
					<ActionButton
						label={t("workspaceSkills.open")}
						disabled={!agentId}
						onPress={() =>
							router.push({
								pathname: "/agents/[id]/skills/workspace-detail",
								params: { id: agentId, key: item.skill_key },
							})
						}
					/>
					<ActionButton
						label="Uninstall"
						disabled={disabled || item.skill_key === "clawdi"}
						onPress={onRemove}
					/>
				</>
			}
		/>
	);
}
export function WorkspaceSkillDetailScreen() {
	const params = useLocalSearchParams<{ id?: string | string[]; key?: string | string[] }>();
	const id = routeParam(params.id),
		key = routeParam(params.key);
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ hosted, workspaceSkills: client } = useMobileApi();
	const detail = useQuery({
		queryKey: accountQueryKey(scope, "workspace-skill-sheet", id, key),
		enabled: Boolean(scope.isReady && id && key && hosted && client),
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease) => {
				if (!hosted || !client || !id || !key) throw new Error("Skill unavailable");
				const matches = (await hosted.listDeployments(lease)).filter(
					(item) => item.agent_id === id,
				);
				if (matches.length !== 1 || !matches[0]) throw new Error("Agent unavailable");
				const deploymentId = matches[0].resource.id;
				const inventory = await client.list(deploymentId, lease);
				const item = inventory.items?.find((item) => item.skill_key === key);
				if (!item) throw new Error("Skill unavailable");
				const result = await client.get(deploymentId, key, lease);
				if (
					result.source.commit !== item.source.commit ||
					result.source.url !== item.source.url ||
					result.source.path !== item.source.path
				)
					throw new Error("Skill revision changed");
				return result;
			}, signal),
	});
	return (
		<SheetPage
			title={key ?? "Skill"}
			fallback={id ? `/agents/${id}/skills?tab=workspace` : "/agents"}
		>
			{detail.isError ? (
				<ApiErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />
			) : detail.data ? (
				<AppText selectable>{detail.data.content}</AppText>
			) : (
				<HeroCardSkeleton />
			)}
		</SheetPage>
	);
}

export function WorkspaceSkillInstallScreen() {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id);
	const { inventory } = useDashboardAgents();
	const matches = inventory.data?.filter((item) => item.agent_id === id);
	if (matches?.length === 1 && matches[0])
		return <WorkspaceSkillsScreen deploymentId={matches[0].resource.id} install />;
	return (
		<SheetPage
			title={workspaceSkillInstallCopy.title}
			fallback={id ? `/agents/${id}/skills` : "/agents"}
		>
			{inventory.isError || inventory.data ? (
				<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
			) : (
				<HeroCardSkeleton />
			)}
		</SheetPage>
	);
}
