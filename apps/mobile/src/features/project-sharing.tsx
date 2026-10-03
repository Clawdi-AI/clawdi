import type { components, Project } from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Share } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ErrorState, LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton, formatDate } from "./cloud-inventory";
import { InventoryList } from "./inventory-list";
import { canManageSharing, linkIsActive, safeShareUrl } from "./project-sharing-state";
import { routeParam } from "./read-helpers";

type Row =
	| { id: string; kind: "link"; value: components["schemas"]["ShareLinkResponse"] }
	| { id: string; kind: "invitation"; value: components["schemas"]["InvitationResponse"] }
	| { id: string; kind: "member"; value: components["schemas"]["MemberResponse"] };

export function ProjectSharingScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ projectId?: string | string[] }>();
	const projectId = routeParam(params.projectId);
	return (
		<ProjectGate key={`${scope.identity}:${scope.generation}:${projectId}`} projectId={projectId} />
	);
}

function ProjectGate({ projectId }: { projectId?: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const project = useQuery({
		queryKey: accountQueryKey(scope, "project-sharing-access", projectId),
		queryFn: ({ signal }) =>
			read((requestSignal) => sharing.getProject(projectId ?? "", requestSignal), signal),
		enabled: scope.isReady && Boolean(projectId),
		retry: false,
	});
	if (!project.isError && project.data && canManageSharing(project.data))
		return <SharingView project={project.data} />;
	return (
		<ReadScreen>
			<AppView className="gap-4 p-6">
				<BackButton />
				{projectId && project.isPending ? (
					<LoadingScreen />
				) : project.isError ? (
					<ErrorState onRetry={project.isFetching ? undefined : () => void project.refetch()} />
				) : (
					<AppText>{t("sharing.unavailable")}</AppText>
				)}
			</AppView>
		</ReadScreen>
	);
}

function SharingView({ project }: { project: Project }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [email, setEmail] = useState("");
	const [label, setLabel] = useState("");
	const [freshLink, setFreshLink] = useState<{ id: string; url: string } | null>(null);
	const presentation = useRef(0);
	const focused = useRef(false);
	useFocusEffect(
		useCallback(() => {
			focused.current = true;
			return () => {
				focused.current = false;
				presentation.current += 1;
				setFreshLink(null);
			};
		}, []),
	);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				presentation.current += 1;
				setFreshLink(null);
			}
		});
		return () => listener.remove();
	}, []);
	const inventory = useQuery({
		queryKey: accountQueryKey(scope, "project-sharing", project.id),
		queryFn: ({ signal }) =>
			read(async (requestSignal) => {
				const [links, invitations, members] = await Promise.all([
					sharing.listLinks(project.id, requestSignal),
					sharing.listInvitations(project.id, requestSignal),
					sharing.listMembers(project.id, requestSignal),
				]);
				return { links, invitations, members };
			}, signal),
		enabled: scope.isReady,
		retry: false,
	});
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "project-sharing", project.id) }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-projects") }),
		]);
	};
	const confirm = (
		title: string,
		message: string,
		mutate: (signal: AbortSignal) => Promise<unknown>,
	) => {
		const scopeSignal = scope.signal;
		Alert.alert(title, message, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: title,
				style: "destructive",
				onPress: () => {
					if (scopeSignal.aborted || !scope.isCurrent() || !focused.current) return;
					void action.run(async (isCurrent) => {
						await read(mutate, scopeSignal);
						if (!isCurrent()) return;
						setFreshLink(null);
						await refresh();
					});
				},
			},
		]);
	};
	const createLink = () =>
		action.run(async (isCurrent) => {
			const epoch = presentation.current;
			const created = await read((signal) =>
				sharing.createLink(project.id, { label: label.trim() || null }, signal),
			);
			if (!isCurrent()) return;
			const url = safeShareUrl(created.url);
			if (
				url &&
				epoch === presentation.current &&
				focused.current &&
				AppState.currentState === "active"
			) {
				setFreshLink({ id: created.id, url });
			}
			setLabel("");
			await refresh();
			if (!url) throw new Error("Invalid share URL");
		});
	const invite = () =>
		action.run(async (isCurrent) => {
			if (!email.trim()) return;
			await read((signal) =>
				sharing.invite(project.id, { email: email.trim().toLowerCase() }, signal),
			);
			if (!isCurrent()) return;
			setEmail("");
			await refresh();
		});
	const rows: Row[] = [
		...(inventory.data?.links ?? []).map(
			(value): Row => ({ id: `link:${value.id}`, kind: "link", value }),
		),
		...(inventory.data?.invitations ?? []).map(
			(value): Row => ({ id: `invitation:${value.id}`, kind: "invitation", value }),
		),
		...(inventory.data?.members ?? []).map(
			(value): Row => ({ id: `member:${value.id}`, kind: "member", value }),
		),
	];
	return (
		<InventoryList
			title={project.name}
			description={t("sharing.description")}
			items={rows}
			empty={t(inventory.isPending ? "loading.app" : "sharing.empty")}
			refreshing={inventory.isRefetching}
			onRefresh={() => {
				if (!inventory.isFetching) void inventory.refetch();
			}}
			error={inventory.isError}
			onRetry={() => void inventory.refetch()}
			busy={inventory.isFetching}
			header={
				<AppView className="gap-3">
					<AppText>{t("sharing.permissions")}</AppText>
					<AppTextInput
						accessibilityLabel={t("sharing.email")}
						placeholder={t("sharing.email")}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="email-address"
						editable={!action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t("sharing.invite")}
						disabled={action.busy || !email.trim()}
						onPress={() => void invite()}
					/>
					<AppTextInput
						accessibilityLabel={t("sharing.label")}
						placeholder={t("sharing.label")}
						value={label}
						onChangeText={setLabel}
						maxLength={200}
						editable={!action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t("sharing.createLink")}
						disabled={action.busy || Boolean(freshLink)}
						onPress={() => void createLink()}
					/>
					{freshLink ? (
						<AppView className="gap-2">
							<AppText>{t("sharing.once")}</AppText>
							<AppText selectable>{freshLink.url}</AppText>
							<NativeButton
								label={t("sharing.shareLink")}
								disabled={action.busy}
								onPress={() =>
									void action.run(async () => {
										if (scope.isCurrent() && !scope.signal.aborted && focused.current)
											await Share.share({ message: freshLink.url });
									})
								}
							/>
							<NativeButton
								label={t("sharing.dismiss")}
								onPress={() => {
									presentation.current += 1;
									setFreshLink(null);
								}}
							/>
						</AppView>
					) : null}
					{action.error ? <AppText accessibilityRole="alert">{t("sharing.failed")}</AppText> : null}
					<NativeButton
						label={t("sharing.stop")}
						disabled={action.busy}
						onPress={() =>
							confirm(t("sharing.stop"), t("sharing.stopWarning"), (signal) =>
								sharing.stopSharing(project.id, signal),
							)
						}
					/>
				</AppView>
			}
			renderItem={(row) => (
				<AppView className="gap-2 rounded-2xl bg-surface p-4">
					{row.kind === "link" ? (
						<>
							<AppText>
								{t("sharing.link")} · {row.value.label || row.value.prefix}
							</AppText>
							<AppText>
								{t(linkIsActive(row.value) ? "sharing.active" : "sharing.inactive")} ·{" "}
								{row.value.redeem_count} {t("sharing.redemptions")}
							</AppText>
							{row.value.expires_at ? (
								<AppText>
									{t("sharing.expires")} {formatDate(row.value.expires_at)}
								</AppText>
							) : null}
							<NativeButton
								label={t("sharing.revoke")}
								disabled={action.busy || Boolean(row.value.revoked_at)}
								onPress={() =>
									confirm(t("sharing.revoke"), t("sharing.revokeWarning"), (signal) =>
										sharing.revokeLink(project.id, row.value.id, signal),
									)
								}
							/>
						</>
					) : row.kind === "invitation" ? (
						<>
							<AppText>
								{t("sharing.invitation")} · {row.value.invitee_email}
							</AppText>
							<NativeButton
								label={t("sharing.cancelInvite")}
								disabled={action.busy}
								onPress={() =>
									confirm(t("sharing.cancelInvite"), t("sharing.cancelWarning"), (signal) =>
										sharing.cancelInvitation(project.id, row.value.id, signal),
									)
								}
							/>
						</>
					) : (
						<>
							<AppText>
								{t("sharing.member")} ·{" "}
								{row.value.user_display || row.value.user_email || t("sharing.unknownMember")}
							</AppText>
							<AppText>{row.value.role}</AppText>
							<NativeButton
								label={t("sharing.removeMember")}
								disabled={action.busy}
								onPress={() =>
									confirm(t("sharing.removeMember"), t("sharing.removeWarning"), (signal) =>
										sharing.removeMember(project.id, row.value.user_id, signal),
									)
								}
							/>
						</>
					)}
				</AppView>
			)}
		/>
	);
}
