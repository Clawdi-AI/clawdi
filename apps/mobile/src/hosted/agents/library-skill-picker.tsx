import { HERO_GRID_CLASS } from "@clawdi/shared/ui";
import {
	agentCloudSkill,
	agentSkillGuardPresentation,
	agentSkillInventory,
	agentSkillStateKey,
	agentSkillsHaveRetryableInstallFailure,
	agentSurfaceCopy,
	fetchAgentProjectSkills,
	identityFor,
	workspaceSkillInstallCopy,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { useAgentConfirmation } from "@/components/dashboard/confirmation";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { SkillCard } from "@/components/skills/skill-card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { NativeList } from "@/components/ui/native-list";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { useAgentDesiredSkills } from "@/hosted/agents/agent-desired-skills-query";
import { useAgentWorkspaceProjections } from "@/hosted/agents/agent-workspace-projections-query";
import { useWorkspaceSkillChanges } from "@/hosted/agents/workspace-skill-changes";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader, useHeaderSearch } from "@/platform/navigation/native-header";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { sheetCancelHeaderOptions } from "@/platform/navigation/sheet-options";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** The browse sheet omits `deploymentId`; the Skills list passes it for GitHub workspace changes. */
export function HostedAgentLibrarySkillsScreen({
	browse = false,
	deploymentId = "",
}: {
	browse?: boolean;
	deploymentId?: string;
} = {}) {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id) ?? "";
	const scope = useAccountScope();
	return (
		<AgentLibrarySkills
			key={`${scope.accountKey}:${scope.generation}:${id}:${deploymentId}`}
			id={id}
			browse={browse}
			deploymentId={deploymentId}
		/>
	);
}

function AgentLibrarySkills({
	id,
	browse,
	deploymentId,
}: {
	id: string;
	browse: boolean;
	deploymentId: string;
}) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
	const router = useRouter();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const { agentExtensions: client, cloud } = useMobileApi();
	const [search, setSearch] = useState("");
	const [accepted, setAccepted] = useState(false);
	const projects = useCloudProjects();
	const workspaceIds = (projects.data ?? [])
		.filter((project) => project.kind === "workspace")
		.map((project) => project.id);
	const library = useQuery({
		queryKey: accountQueryKey(scope, "library-picker-skills", workspaceIds.join(","), search),
		enabled: scope.isReady && Boolean(projects.data),
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease) => {
				const skills = await fetchAgentProjectSkills(workspaceIds, (projectId, page, pageSize) =>
					cloud.listSkills(
						{
							project_id: projectId,
							page,
							page_size: pageSize,
							q: search || undefined,
						},
						lease,
					),
				);
				return Array.from(
					new Map(
						skills.filter((skill) => skill.authority === "cloud").map((skill) => [skill.id, skill]),
					).values(),
				);
			}, signal),
	});
	const inventory = useAgentDesiredSkills(id);
	const projections = useAgentWorkspaceProjections(id, !browse);
	// GitHub workspace uninstalls reuse the install sheet's journal; the browse sheet has none.
	const changes = useWorkspaceSkillChanges(deploymentId);
	// Background polling keeps the last inventory; only a missing or failed load blocks changes.
	const ready = Boolean(id) && Boolean(inventory.data) && !inventory.isError;
	const busy = action.busy || changes.busy;
	const disabled = busy || !ready;
	const sheet = useSheet<boolean>({
		fallback: `/agents/${id}/skills`,
		busy: browse && action.busy,
	});
	const refresh = () => {
		void inventory.refetch();
		if (!browse) projections.refetch();
		if (browse) {
			void projects.refetch();
			void library.refetch();
		}
		if (deploymentId) {
			void changes.inventory.refetch();
			void changes.deployment.refetch();
		}
	};
	const mutate = (skillId: string, present: boolean, guarded = false) =>
		(guarded ? action.runOrThrow : action.run)(async (current) => {
			if (!ready) throw new Error(agentSurfaceCopy.unavailable);
			await read((signal) => client.setLibraryReference(id, skillId, present, signal));
			if (!current()) return;
			setAccepted(true);
			await inventory.refetch();
			// Like Web, an accepted install closes the sheet onto the refreshed Skills list.
			if (browse && current()) await sheet.close(true);
		});
	const remove = (skillId: string, name: string) => {
		const foreground = capture();
		const signal = scope.signal;
		confirmationDialog.request({
			title: t("agentExtensions.uninstallTitle", { name }),
			description: t("agentExtensions.uninstallWarning"),
			confirmLabel: t("agentExtensions.uninstallConfirm"),
			onConfirm: () => {
				if (foreground() && scope.isCurrent() && !signal.aborted)
					return mutate(skillId, false, true);
			},
		});
	};
	const items = library.data ?? [];
	const libraryError = projects.error ?? library.error;
	const libraryIsError = projects.isError || library.isError;
	const libraryIsPending = projects.isPending || library.isPending;
	const headerSearch = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: t("workspaceSkills.search"),
		maxLength: 200,
	});
	const [closeError, setCloseError] = useState<unknown>();
	if (browse)
		return (
			<SafeAreaScreen>
				<NativeHeader
					title={agentSurfaceCopy.installSkill}
					actions={[
						{
							id: "close",
							label: t("accountDeletion.cancel"),
							disabled: action.busy,
							onPress: () => void sheet.close().catch(setCloseError),
						},
					]}
				/>
				<Stack.Screen options={sheetCancelHeaderOptions} />
				<Stack.SearchBar {...headerSearch} />
				<NativeList
					data={libraryIsError ? [] : items}
					keyExtractor={(item) => item.id}
					refreshing={projects.isRefetching || library.isRefetching}
					onRefresh={refresh}
					header={
						<>
							<NativeSegments
								value="library"
								options={[
									{ value: "library", label: workspaceSkillInstallCopy.library },
									{ value: "github", label: workspaceSkillInstallCopy.github },
								]}
								disabled={action.busy}
								onChange={(value) => {
									if (value === "github")
										router.replace({ pathname: "/agents/[id]/skills/github", params: { id } });
								}}
							/>

							{!id || inventory.isError ? (
								<ApiErrorPanel
									error={inventory.error}
									title={t("workspaceSkills.loadError")}
									onRetry={refresh}
								/>
							) : inventory.isPending ? (
								<AppText>{t("workspaceSkills.unavailable")}</AppText>
							) : null}
							{closeError ? <ApiErrorPanel error={closeError} /> : null}
							{action.error ? (
								<ApiErrorPanel error={action.failure} title={t("workspaceSkills.updateError")} />
							) : null}
						</>
					}
					empty={
						libraryIsError ? (
							<ApiErrorPanel error={libraryError} onRetry={refresh} />
						) : libraryIsPending ? (
							<HeroCardSkeleton />
						) : (
							<EmptyState title={t("workspaceSkills.noMatches")} />
						)
					}
					renderItem={({ item }) => {
						// A Library reference or linked Project already provides it, so Install would be a no-op.
						const desired = agentCloudSkill(inventory.data?.skills ?? [], item.id);
						return (
							<HeroCard
								key={item.id}
								icon={
									<IconChip>
										<AppText>{identityFor(item.name).emoji}</AppText>
									</IconChip>
								}
								title={item.name}
								description={item.description}
								actions={
									<ActionButton
										label={t(
											desired
												? `agentExtensions.${agentSkillStateKey(desired)}`
												: "agentExtensions.install",
										)}
										disabled={disabled || Boolean(desired)}
										onPress={() => {
											if (!desired) void mutate(item.id, true);
										}}
									/>
								}
							/>
						);
					}}
				/>
			</SafeAreaScreen>
		);
	// Like Web's Skills tab: managed skills plus the workspace's agent-synced and GitHub rows.
	const rows = agentSkillInventory(
		inventory.data?.skills ?? [],
		projections.data ?? [],
		changes.inventory.data?.items ?? [],
	);
	return (
		<AgentCollection
			data={!id || inventory.isPending || inventory.isError ? [] : rows}
			keyExtractor={(row) => row.entity.skill_key}
			refreshing={inventory.isRefetching}
			onRefresh={refresh}
			renderItem={({ item: row }) => {
				const item = row.managed;
				if (!item)
					return (
						<SkillCard
							key={row.entity.skill_key}
							skill={row.entity}
							readOnly={row.projectionOnly}
							provenanceLabel={row.projectionOnly ? agentSurfaceCopy.syncedFromAgent : undefined}
							link={
								projections.workspace
									? {
											to: {
												pathname: "/agents/[id]/skills/[...key]",
												params: {
													id,
													project: projections.workspace,
													key: row.entity.skill_key.split("/"),
												},
											},
										}
									: undefined
							}
						/>
					);
				const identity = identityFor(item.name || item.skill_key);
				const guardPresentation = agentSkillGuardPresentation(item);
				return (
					<HeroCard
						key={item.skill_key}
						icon={
							<IconChip tint={identity.colorClasses}>
								<AppText>{identity.emoji}</AppText>
							</IconChip>
						}
						title={item.name}
						footer={[item.source, t(`agentExtensions.${agentSkillStateKey(item)}`)]}
						badges={
							item.read_only ? (
								<Badge variant="secondary">
									<AppText>{agentSurfaceCopy.readOnly}</AppText>
								</Badge>
							) : undefined
						}
						actions={
							item.source === "github" && !item.read_only ? (
								<>
									<ActionButton
										label={t("workspaceSkills.open")}
										onPress={() =>
											router.push({
												pathname: "/agents/[id]/skills/workspace-detail",
												params: { id, key: item.skill_key },
											})
										}
									/>
									{item.skill_key === "clawdi" ? null : (
										<ActionButton
											label={t("workspaceSkills.uninstallAction")}
											disabled={
												busy ||
												!changes.enabled ||
												!changes.inventory.data?.items?.some(
													(desired) => desired.skill_key === item.skill_key,
												)
											}
											onPress={() =>
												changes.prepare(
													{ action: "uninstall", skillKey: item.skill_key },
													item.name || item.skill_key,
												)
											}
										/>
									)}
								</>
							) : item.source === "library" && item.skill_id ? (
								<>
									<ActionButton
										label={t("agentExtensions.view")}
										disabled={!item.project_id || !item.source_skill_key}
										onPress={() =>
											router.push({
												pathname: "/agents/[id]/skills/[...key]",
												params: {
													id,
													project: item.project_id ?? "",
													key: (item.source_skill_key ?? "").split("/"),
												},
											})
										}
									/>
									<ActionButton
										label={t("workspaceSkills.uninstallAction")}
										disabled={disabled || item.read_only}
										onPress={() => {
											if (item.skill_id) remove(item.skill_id, item.name || item.skill_key);
										}}
									/>
								</>
							) : undefined
						}
					>
						{guardPresentation ? (
							<AppText className="text-sm text-destructive">
								{t(`agentExtensions.${guardPresentation.message}`)}
							</AppText>
						) : null}
					</HeroCard>
				);
			}}
			title={t("skills.title")}
			description={t("workspaceSkills.inventoryDescription")}
			navigation={<AgentSectionNavigation agentId={id} section="skills" />}
		>
			{changes.journal}
			{accepted ? <AppText>{t("agentExtensions.accepted")}</AppText> : null}
			{action.error ? (
				<ApiErrorPanel error={action.failure} title={t("workspaceSkills.updateError")} />
			) : null}
			{inventory.data?.removal_failures?.length ? (
				<AppText accessibilityRole="alert">{t("agentExtensions.removalFailed")}</AppText>
			) : null}
			{inventory.data &&
			agentSkillsHaveRetryableInstallFailure(
				inventory.data.skills,
				changes.inventory.data?.items ?? [],
			) ? (
				<Alert variant="destructive" title={t("agentExtensions.updateFailedTitle")}>
					{t("agentExtensions.updateFailed")}
				</Alert>
			) : null}
			{projections.error ? (
				<ApiErrorPanel
					error={projections.error}
					title={agentSurfaceCopy.couldnTLoadSyncedSkills}
					onRetry={projections.refetch}
				/>
			) : null}
			{!id || inventory.isError ? (
				<ApiErrorPanel
					error={inventory.error}
					title={t("workspaceSkills.loadError")}
					onRetry={refresh}
				/>
			) : inventory.isPending ? (
				<WebView recipe={HERO_GRID_CLASS}>
					{[0, 1, 2].map((i) => (
						<HeroCardSkeleton key={i} />
					))}
				</WebView>
			) : !rows.length ? (
				<EmptyState variant="inset" description={t("workspaceSkills.inventoryEmpty")} />
			) : null}

			{confirmationDialog.dialog}
			{changes.dialog}
		</AgentCollection>
	);
}
