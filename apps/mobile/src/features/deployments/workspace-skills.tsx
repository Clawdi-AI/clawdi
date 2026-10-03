import {
	type DeployComponents,
	parseWorkspaceSkillGitHubInput,
	type WorkspaceSkillMutation,
	workspaceSkillMutationsAvailable,
} from "@clawdi/shared/api";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { useLocalSearchParams } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton } from "../../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../ui/primitives";
import { InventoryList } from "../inventory-list";
import { routeParam } from "../read-helpers";
import { type SkillAttempt, skillAttemptAfterFailure } from "./skill-attempt";
import { skillAttempts } from "./skill-attempt-storage";
import { canPollDeployment } from "./state";

export function WorkspaceSkillsScreen() {
	const params = useLocalSearchParams<{ deploymentId?: string | string[] }>();
	const id = routeParam(params.deploymentId) ?? "";
	const scope = useAccountScope();
	return <WorkspaceSkills key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}

function WorkspaceSkills({ id }: { id: string }) {
	const t = useI18n();
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
				if (!client) throw new Error("Unavailable");
				return client.list(id, lease);
			}, signal),
	});
	const deployment = useQuery({
		queryKey: accountQueryKey(scope, "workspace-skills-deployment", id),
		enabled: Boolean(id && hosted && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!hosted) throw new Error("Unavailable");
				return hosted.getDeployment(id, lease);
			}, signal),
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
	const submit = (attempt: SkillAttempt, fresh = false) =>
		void action.run(async (current) => {
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
			} catch (error) {
				const rejected = skillAttemptAfterFailure(attempt, error);
				if (owns() && rejected.status === "rejected") {
					await skillAttempts.replaceAttempt(storageKey, sending, rejected, owns);
					if (owns()) setSaved(rejected);
				}
				throw error;
			}
		});
	const confirm = (label: string, message: string, run: () => void) => {
		const ticket = ++confirmation.current;
		const visible = capture();
		Alert.alert(label, message, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: label,
				style: "destructive",
				onPress: () => {
					if (
						ticket !== confirmation.current ||
						!scope.isCurrent() ||
						scope.signal.aborted ||
						!visible()
					)
						return;
					confirmation.current++;
					run();
				},
			},
		]);
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
			submit(attempt, true),
		);
	};
	let install: WorkspaceSkillMutation | null = null;
	try {
		install = { action: "install", request: parseWorkspaceSkillGitHubInput(source) };
	} catch {
		/* Invalid drafts stay local. */
	}
	return (
		<InventoryList
			title={t("workspaceSkills.title")}
			description={t("workspaceSkills.description")}
			empty={t("workspaceSkills.empty")}
			items={(inventory.data?.items ?? []).map((item) => ({ ...item, id: item.skill_key }))}
			refreshing={inventory.isFetching}
			onRefresh={() => {
				setStartedAt(Date.now());
				void inventory.refetch();
				void deployment.refetch();
			}}
			error={inventory.isError || deployment.isError}
			onRetry={() => {
				setStartedAt(Date.now());
				void inventory.refetch();
				void deployment.refetch();
			}}
			busy={action.busy}
			header={
				<AppView className="gap-3">
					{!enabled && !saved ? <AppText>{t("workspaceSkills.unavailable")}</AppText> : null}
					<AppTextInput
						value={source}
						onChangeText={setSource}
						editable={enabled}
						maxLength={2048}
						accessibilityLabel={t("workspaceSkills.source")}
						placeholder={t("workspaceSkills.source")}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t("workspaceSkills.install")}
						disabled={!enabled || !install}
						onPress={() => {
							if (install) prepare(install);
						}}
					/>
					{saved ? (
						<>
							<AppText>{t("workspaceSkills.uncertain")}</AppText>
							<AppText selectable>
								{saved.mutation.action === "install"
									? `${saved.mutation.request.repo}/${saved.mutation.request.path ?? ""}`
									: saved.mutation.skillKey}
							</AppText>
							<NativeButton
								label={t("workspaceSkills.retry")}
								disabled={
									action.busy ||
									storageError ||
									!storageKey ||
									!client ||
									saved.status === "rejected"
								}
								onPress={() => submit(saved)}
							/>
							{saved.status !== "uncertain" ? (
								<NativeButton
									label={t("workspaceSkills.discard")}
									disabled={action.busy || storageError}
									onPress={() =>
										confirm(
											t("workspaceSkills.discard"),
											t("workspaceSkills.discardWarning"),
											() =>
												void action.run(async (current) => {
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
					<NativeButton
						label={t("workspaceSkills.reload")}
						disabled={action.busy}
						onPress={() => setEpoch((value) => value + 1)}
					/>
					{accepted ? (
						<AppText accessibilityRole="alert">{t("workspaceSkills.accepted")}</AppText>
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("workspaceSkills.error")}</AppText>
					) : null}
				</AppView>
			}
			renderItem={(item) => (
				<WorkspaceSkillItem
					deploymentId={id}
					item={item}
					disabled={!enabled}
					onRemove={() => prepare({ action: "uninstall", skillKey: item.skill_key })}
				/>
			)}
		/>
	);
}

function WorkspaceSkillItem({
	deploymentId,
	item,
	disabled,
	onRemove,
}: {
	deploymentId: string;
	item: DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"];
	disabled: boolean;
	onRemove: () => void;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { workspaceSkills: client } = useMobileApi();
	const [open, setOpen] = useState(false);
	const detail = useQuery({
		queryKey: accountQueryKey(
			scope,
			"workspace-skill-detail",
			deploymentId,
			item.skill_key,
			item.source.url,
			item.source.path,
			item.source.commit,
		),
		enabled: Boolean(open && client && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease) => {
				if (!client) throw new Error("Unavailable");
				const result = await client.get(deploymentId, item.skill_key, lease);
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
		<AppView className="gap-3 rounded-xl bg-surface p-4">
			<AppText>{item.skill_key}</AppText>
			<AppText>{t(`workspaceSkills.${item.status}`)}</AppText>
			<AppText selectable>
				{item.source.url} · {item.source.path} · {item.source.commit}
			</AppText>
			<NativeButton
				label={t("workspaceSkills.open")}
				onPress={() => {
					setOpen(true);
					if (open) void detail.refetch();
				}}
			/>
			{open && detail.isPending ? <AppText>{t("loading.app")}</AppText> : null}
			{open && detail.isError ? <AppText>{t("workspaceSkills.error")}</AppText> : null}
			{open && detail.data && !detail.isError ? (
				<AppText selectable>{detail.data.content}</AppText>
			) : null}
			<NativeButton
				label={t("workspaceSkills.uninstall")}
				disabled={disabled || item.skill_key === "clawdi"}
				onPress={onRemove}
			/>
		</AppView>
	);
}
