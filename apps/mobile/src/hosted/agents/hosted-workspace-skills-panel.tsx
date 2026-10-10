import { parseWorkspaceSkillGitHubInput, type WorkspaceSkillMutation } from "@clawdi/shared/api";
import { agentSurfaceCopy, workspaceSkillInstallCopy } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ActionButton } from "@/components/dashboard/controls";
import { HeroCardSkeleton } from "@/components/entity-card";
import { Input as AppTextInput, Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { useWorkspaceSkillChanges } from "@/hosted/agents/workspace-skill-changes";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { useSheet } from "@/platform/navigation/use-sheet";

function WorkspaceSkillInstallSheet({ id }: { id: string }) {
	const t = useI18n();
	const [source, setSource] = useState("");
	const changes = useWorkspaceSkillChanges(id, { onAccepted: () => installSheet.close(true) });
	const agentId = changes.deployment.data?.agent_id;
	const fallback = agentId ? (`/agents/${agentId}/skills` as const) : "/agents";
	const installSheet = useSheet<boolean>({ fallback, busy: changes.busy });
	let installRequest: WorkspaceSkillMutation | null = null;
	try {
		installRequest = { action: "install", request: parseWorkspaceSkillGitHubInput(source) };
	} catch {
		/* Invalid drafts stay local. */
	}
	return (
		<SheetPage
			title={workspaceSkillInstallCopy.title}
			description={workspaceSkillInstallCopy.description}
			busy={changes.busy}
			sheet={installSheet}
			fallback={fallback}
		>
			<NativeSegments
				value="github"
				options={[
					{ value: "library", label: workspaceSkillInstallCopy.library },
					{ value: "github", label: workspaceSkillInstallCopy.github },
				]}
				disabled={changes.busy}
				onChange={(value) => {
					if (value === "library" && agentId)
						router.replace({ pathname: "/agents/[id]/skills/browse", params: { id: agentId } });
				}}
			/>
			{changes.inventory.isError || changes.deployment.isError ? (
				<ApiErrorPanel
					error={changes.inventory.error ?? changes.deployment.error}
					onRetry={() => {
						void changes.inventory.refetch();
						void changes.deployment.refetch();
					}}
				/>
			) : null}
			<AppView className="gap-3">
				{!changes.enabled && !changes.journaled ? (
					<AppText>{t("workspaceSkills.unavailable")}</AppText>
				) : null}
				<Label>{agentSurfaceCopy.gitHubSkillRepository}</Label>
				<AppTextInput
					value={source}
					onChangeText={setSource}
					editable={changes.enabled}
					maxLength={2048}
					accessibilityLabel={t("workspaceSkills.source")}
					placeholder={t("workspaceSkills.source")}
				/>
				<ActionButton
					label={t("workspaceSkills.install")}
					disabled={!changes.enabled || !installRequest}
					onPress={() => {
						if (installRequest) changes.prepare(installRequest);
					}}
				/>
				{changes.journal}
			</AppView>
			{changes.dialog}
		</SheetPage>
	);
}

export function WorkspaceSkillDetailScreen() {
	const t = useI18n();
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
			title={key ?? t("skills.singular")}
			fallback={id ? `/agents/${id}/skills` : "/agents"}
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
	const scope = useAccountScope();
	const { inventory } = useDashboardAgents();
	const matches = inventory.data?.filter((item) => item.agent_id === id);
	if (matches?.length === 1 && matches[0]) {
		const deploymentId = matches[0].resource.id;
		return (
			<WorkspaceSkillInstallSheet
				key={`${scope.accountKey}:${scope.generation}:${deploymentId}`}
				id={deploymentId}
			/>
		);
	}
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
