import type { components } from "@clawdi/shared/api";
import { focusManager, onlineManager, useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { canPollDeployment } from "./deployments/state";
import { InventoryList } from "./inventory-list";
import { routeParam } from "./read-helpers";
import { useCloudSkills } from "./skills";

export function AgentLibrarySkillsScreen() {
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const id = routeParam(params.agentId) ?? "";
	const scope = useAccountScope();
	return <AgentLibrarySkills key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}

function AgentLibrarySkills({ id }: { id: string }) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const { agentExtensions: client } = useMobileApi();
	const [browse, setBrowse] = useState(false);
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
	const disabled =
		action.busy || !id || !inventory.data || inventory.isError || inventory.isFetching;
	const refresh = () => {
		setStartedAt(Date.now());
		void inventory.refetch();
		if (browse) void library.refetch();
	};
	const mutate = (skillId: string, present: boolean) =>
		action.run(async (current) => {
			if (disabled) return;
			await read((signal) => client.setLibraryReference(id, skillId, present, signal));
			if (!current()) return;
			setAccepted(true);
			setStartedAt(Date.now());
			await inventory.refetch();
		});
	const remove = (skillId: string) => {
		const foreground = capture();
		const signal = scope.signal;
		Alert.alert(t("agentExtensions.remove"), t("agentExtensions.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("agentExtensions.remove"),
				style: "destructive",
				onPress: () => {
					if (foreground() && scope.isCurrent() && !signal.aborted) void mutate(skillId, false);
				},
			},
		]);
	};
	const header = (
		<AppView className="gap-3">
			<NativeButton
				label={t(browse ? "agentExtensions.current" : "agentExtensions.library")}
				disabled={action.busy}
				onPress={() => setBrowse(!browse)}
			/>
			{browse ? (
				<AppTextInput
					accessibilityLabel={t("agentExtensions.search")}
					placeholder={t("agentExtensions.search")}
					value={search}
					onChangeText={setSearch}
				/>
			) : null}
			{accepted ? <AppText>{t("agentExtensions.accepted")}</AppText> : null}
			{action.error ? (
				<AppText accessibilityRole="alert">{t("agentExtensions.failed")}</AppText>
			) : null}
			{inventory.data?.removal_failures?.length ? (
				<AppText accessibilityRole="alert">{t("agentExtensions.removalFailed")}</AppText>
			) : null}
		</AppView>
	);
	const common = {
		title: t("agentExtensions.title"),
		description: t("agentExtensions.description"),
		empty: t(inventory.isPending ? "loading.app" : "agentExtensions.empty"),
		header,
		refreshing: inventory.isRefetching,
		onRefresh: refresh,
		onRetry: refresh,
	};
	if (browse) {
		const items = Array.from(
			new Map(
				(library.data?.pages.flatMap((page) => page.items) ?? [])
					.filter((item) => item.authority === "cloud")
					.map((item) => [item.id, item]),
			).values(),
		);
		return (
			<InventoryList
				{...common}
				items={items}
				error={!id || inventory.isError || library.isError}
				busy={library.isFetching || inventory.isFetching}
				more={library.hasNextPage}
				onMore={() => void library.fetchNextPage()}
				renderItem={(item) => (
					<AppView className="gap-3 rounded-2xl bg-card p-4">
						<AppText className="text-lg text-foreground">{item.name}</AppText>
						<AppText>{item.description}</AppText>
						<NativeButton
							label={t("agentExtensions.attach")}
							disabled={
								disabled ||
								inventory.data?.skills.some(
									(skill) => skill.source === "library" && skill.skill_id === item.id,
								)
							}
							onPress={() => void mutate(item.id, true)}
						/>
					</AppView>
				)}
			/>
		);
	}
	return (
		<InventoryList
			{...common}
			items={(inventory.data?.skills ?? []).map((item) => ({ ...item, id: item.skill_key }))}
			error={!id || inventory.isError}
			busy={inventory.isFetching}
			renderItem={(item) => (
				<AppView className="gap-3 rounded-2xl bg-card p-4">
					<AppText className="text-lg text-foreground">{item.name}</AppText>
					<AppText>
						{item.source} ·{" "}
						{t(
							item.convergence === "failed"
								? "agentExtensions.failedState"
								: item.convergence === "installed"
									? "agentExtensions.installed"
									: "agentExtensions.not_observed",
						)}
					</AppText>
					{item.source === "library" && item.skill_id ? (
						<>
							<NativeButton
								label={t("agentExtensions.view")}
								disabled={!item.project_id || !item.source_skill_key}
								onPress={() =>
									router.push({
										pathname: "/skills/detail",
										params: {
											projectId: item.project_id ?? "",
											skillKey: item.source_skill_key ?? "",
										},
									})
								}
							/>
							<NativeButton
								label={t("agentExtensions.remove")}
								disabled={disabled || item.read_only}
								onPress={() => {
									if (item.skill_id) remove(item.skill_id);
								}}
							/>
						</>
					) : (
						<AppText>{t("agentExtensions.readOnly")}</AppText>
					)}
				</AppView>
			)}
		/>
	);
}
