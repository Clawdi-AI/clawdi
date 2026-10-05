import {
	type AgentProjectBinding,
	agentProjectBindingsQueryKey,
	buildContextBindingReorder,
	resolveAgentProjectScope,
} from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton, NativePicker } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { useCloudAgent } from "./cloud-inventory";
import { InventoryList } from "./inventory-list";
import { useCloudProjects } from "./projects";
import { routeParam } from "./read-helpers";

export function AgentProjectsScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = routeParam(params.agentId);
	return (
		<BindingsView key={`${scope.identity}:${scope.generation}:${agentId}`} agentId={agentId} />
	);
}

function BindingsView({ agentId }: { agentId?: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { agentProjects } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const projects = useCloudProjects();
	const agent = useCloudAgent(agentId);
	const [selection, setSelection] = useState("");
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, ...agentProjectBindingsQueryKey(agentId)),
		queryFn: ({ signal }) =>
			read((requestSignal) => agentProjects.listBindings(agentId ?? "", requestSignal), signal),
		enabled: scope.isReady && Boolean(agentId),
		retry: false,
	});
	let ordered: AgentProjectBinding[] = [];
	let invalidScope = false;
	if (bindings.data && agent.data) {
		try {
			ordered = resolveAgentProjectScope(bindings.data, agent.data.default_project_id).bindings;
		} catch {
			invalidScope = true;
		}
	}
	const failed = !agentId || bindings.isError || agent.isError || projects.isError || invalidScope;
	const loading = Boolean(agentId) && (bindings.isPending || projects.isPending || agent.isPending);
	const busy = bindings.isFetching || projects.isFetching || agent.isFetching;
	const disabled = failed || loading || action.busy || busy;
	const context = ordered.filter((binding) => binding.binding_type === "context");
	const available = (projects.data ?? []).filter(
		(project) =>
			project.kind === "workspace" &&
			!project.archived_at &&
			!ordered.some((binding) => binding.project_id === project.id),
	);
	const selected =
		available.find((project) => project.id === selection)?.id ?? available[0]?.id ?? "";
	const refresh = async () => {
		await Promise.all([bindings.refetch(), projects.refetch(), agent.refetch()]);
	};
	const mutate = (operation: (id: string, signal: AbortSignal) => Promise<unknown>) =>
		action.run(async (isCurrent) => {
			if (!agentId || disabled) return;
			await read((signal) => operation(agentId, signal));
			if (isCurrent()) await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
		});
	const unlink = (binding: AgentProjectBinding) => {
		const signal = scope.signal;
		Alert.alert(t("bindings.unlink"), t("bindings.unlinkWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("bindings.unlink"),
				style: "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent() || binding.binding_type !== "context") return;
					void mutate((id, requestSignal) => agentProjects.unlink(id, binding.id, requestSignal));
				},
			},
		]);
	};
	return (
		<InventoryList
			title={t("bindings.title")}
			description={t("bindings.description")}
			items={failed ? [] : ordered}
			empty={t(loading ? "loading.app" : "bindings.empty")}
			refreshing={bindings.isRefetching || projects.isRefetching || agent.isRefetching}
			onRefresh={() => {
				if (!busy) void refresh();
			}}
			error={failed}
			onRetry={() => void refresh()}
			busy={busy}
			header={
				<AppView className="gap-3">
					{available.length ? (
						<>
							<NativePicker
								value={selected}
								options={available.map((project) => ({ value: project.id, label: project.name }))}
								onValueChange={setSelection}
								disabled={disabled}
							/>
							<NativeButton
								label={t("bindings.link")}
								disabled={disabled || !selected}
								onPress={() =>
									void mutate((id, signal) => agentProjects.link(id, selected, signal))
								}
							/>
						</>
					) : (
						<AppText>{t("bindings.noAvailable")}</AppText>
					)}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("bindings.failed")}</AppText>
					) : null}
				</AppView>
			}
			renderItem={(binding) => (
				<AppView className="gap-3 rounded-2xl bg-card p-4">
					<AppText className="text-lg text-foreground">
						{projects.data?.find((project) => project.id === binding.project_id)?.name ??
							t("projects.unknown")}
					</AppText>
					{binding.binding_type === "primary" ? (
						<AppText>{t("bindings.primary")}</AppText>
					) : (
						<>
							<AppText>
								{t("bindings.priority")}: {binding.priority}
							</AppText>
							<NativeButton
								label={t("bindings.up")}
								disabled={disabled || context[0]?.id === binding.id}
								onPress={() =>
									void mutate((id, signal) =>
										agentProjects.reorder(
											id,
											buildContextBindingReorder(ordered, binding.id, -1),
											signal,
										),
									)
								}
							/>
							<NativeButton
								label={t("bindings.down")}
								disabled={disabled || context[context.length - 1]?.id === binding.id}
								onPress={() =>
									void mutate((id, signal) =>
										agentProjects.reorder(
											id,
											buildContextBindingReorder(ordered, binding.id, 1),
											signal,
										),
									)
								}
							/>
							<NativeButton
								label={t("bindings.unlink")}
								disabled={disabled}
								onPress={() => unlink(binding)}
							/>
						</>
					)}
				</AppView>
			)}
		/>
	);
}
