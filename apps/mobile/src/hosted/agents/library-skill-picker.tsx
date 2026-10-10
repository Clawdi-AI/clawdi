import type { components } from "@clawdi/shared/api";
import { HERO_GRID_CLASS } from "@clawdi/shared/ui";
import {
	agentSkillGuardPresentation,
	agentSurfaceCopy,
	identityFor,
	workspaceSkillInstallCopy,
} from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { useAgentConfirmation } from "@/components/dashboard/confirmation";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { NativeList } from "@/components/ui/native-list";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { canPollDeployment } from "@/hosted/deployment-status";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { useCloudSkills } from "@/pages/dashboard/skills/page";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader, useHeaderSearch } from "@/platform/navigation/native-header";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { sheetCancelHeaderOptions } from "@/platform/navigation/sheet-options";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function HostedAgentLibrarySkillsScreen({ browse = false }: { browse?: boolean } = {}) {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id) ?? "";
	const scope = useAccountScope();
	return (
		<AgentLibrarySkills
			key={`${scope.accountKey}:${scope.generation}:${id}`}
			id={id}
			browse={browse}
		/>
	);
}

function AgentLibrarySkills({ id, browse }: { id: string; browse: boolean }) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
	const router = useRouter();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const { agentExtensions: client } = useMobileApi();
	const [search, setSearch] = useState("");
	const [accepted, setAccepted] = useState(false);
	const [startedAt, setStartedAt] = useState(Date.now);
	const focused = useIsFocused();
	const library = useCloudSkills(undefined, search);
	const inventory = useQuery<components["schemas"]["AgentSkillDesiredListResponse"]>({
		queryKey: accountQueryKey(scope, "agent-desired-skills", id),
		enabled: Boolean(id && scope.isReady),
		retry: false,
		queryFn: ({ signal }) => read((lease) => client.listSkills(id, lease), signal),
		refetchInterval: (query) =>
			focused &&
			!query.state.error &&
			query.state.data?.skills.some((item) => item.convergence === "not_observed") &&
			canPollDeployment(startedAt, Date.now(), focusManager.isFocused(), onlineManager.isOnline())
				? 5000
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	// Background polling keeps the last inventory; only a missing or failed load blocks changes.
	const ready = Boolean(id) && Boolean(inventory.data) && !inventory.isError;
	const disabled = action.busy || !ready;
	const sheet = useSheet<boolean>({
		fallback: `/agents/${id}/skills`,
		busy: browse && action.busy,
	});
	const refresh = () => {
		setStartedAt(Date.now());
		void inventory.refetch();
		if (browse) void library.refetch();
	};
	const mutate = (skillId: string, present: boolean, guarded = false) =>
		(guarded ? action.runOrThrow : action.run)(async (current) => {
			if (!ready) throw new Error(agentSurfaceCopy.unavailable);
			await read((signal) => client.setLibraryReference(id, skillId, present, signal));
			if (!current()) return;
			setAccepted(true);
			setStartedAt(Date.now());
			await inventory.refetch();
			// Like Web, an accepted install closes the sheet onto the refreshed Skills list.
			if (browse && current()) await sheet.close(true);
		});
	const remove = (skillId: string) => {
		const foreground = capture();
		const signal = scope.signal;
		confirmationDialog.request({
			title: t("agentExtensions.remove"),
			description: t("agentExtensions.removeWarning"),
			confirmLabel: t("agentExtensions.remove"),
			onConfirm: () => {
				if (foreground() && scope.isCurrent() && !signal.aborted)
					return mutate(skillId, false, true);
			},
		});
	};
	const items = Array.from(
		new Map(
			(library.data?.pages.flatMap((page) => page.items) ?? [])
				.filter((item) => item.authority === "cloud")
				.map((item) => [item.id, item]),
		).values(),
	);
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
				<Stack.Screen
					options={{ ...sheetCancelHeaderOptions, headerSearchBarOptions: headerSearch }}
				/>
				<NativeList
					data={library.isError ? [] : items}
					keyExtractor={(item) => item.id}
					refreshing={library.isRefetching}
					onRefresh={() => void library.refetch()}
					hasMore={library.hasNextPage}
					loadingMore={library.isFetching}
					onLoadMore={() => void library.fetchNextPage()}
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
								<ApiErrorPanel error={action.error} title={t("workspaceSkills.updateError")} />
							) : null}
						</>
					}
					empty={
						library.isError ? (
							<ApiErrorPanel error={library.error} onRetry={() => void library.refetch()} />
						) : library.isPending ? (
							<HeroCardSkeleton />
						) : (
							<EmptyState title={t("workspaceSkills.noMatches")} />
						)
					}
					renderItem={({ item }) => (
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
									label={t("agentExtensions.install")}
									disabled={
										disabled ||
										inventory.data?.skills.some(
											(skill) => skill.source === "library" && skill.skill_id === item.id,
										)
									}
									onPress={() => void mutate(item.id, true)}
								/>
							}
						/>
					)}
				/>
			</SafeAreaScreen>
		);
	return (
		<AgentCollection
			data={!id || inventory.isPending || inventory.isError ? [] : (inventory.data?.skills ?? [])}
			keyExtractor={(item) => item.skill_key}
			refreshing={inventory.isRefetching}
			onRefresh={refresh}
			renderItem={({ item }) => {
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
						footer={[
							item.source,
							t(
								guardPresentation
									? `agentExtensions.${guardPresentation.title}`
									: item.convergence === "failed"
										? "agentExtensions.failedState"
										: item.convergence === "installed"
											? "agentExtensions.installed"
											: "agentExtensions.not_observed",
							),
						]}
						badges={
							item.read_only ? (
								<Badge variant="secondary">
									<AppText>{agentSurfaceCopy.readOnly}</AppText>
								</Badge>
							) : undefined
						}
						actions={
							item.source === "library" && item.skill_id ? (
								<>
									<ActionButton
										label={t("agentExtensions.view")}
										disabled={!item.project_id || !item.source_skill_key}
										onPress={() =>
											router.push({
												pathname: "/skills/[key]",
												params: {
													projectId: item.project_id ?? "",
													key: item.source_skill_key ?? "",
												},
											})
										}
									/>
									<ActionButton
										label={t("workspaceSkills.uninstallAction")}
										disabled={disabled || item.read_only}
										onPress={() => {
											if (item.skill_id) remove(item.skill_id);
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
			{accepted ? <AppText>{t("agentExtensions.accepted")}</AppText> : null}
			{action.error ? (
				<ApiErrorPanel error={action.error} title={t("workspaceSkills.updateError")} />
			) : null}
			{inventory.data?.removal_failures?.length ? (
				<AppText accessibilityRole="alert">{t("agentExtensions.removalFailed")}</AppText>
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
			) : !inventory.data?.skills.length ? (
				<EmptyState variant="inset" description={t("workspaceSkills.inventoryEmpty")} />
			) : null}

			{confirmationDialog.dialog}
		</AgentCollection>
	);
}
