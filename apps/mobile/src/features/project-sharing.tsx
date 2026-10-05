import type { Project } from "@clawdi/shared/api";
import { shareProjectClasses } from "@clawdi/shared/ui";
import { SHARING_COPY } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Share } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DetailBackLink, LibraryPage } from "../ui/detail/layout";
import { ErrorState, LoadingScreen } from "../ui/feedback";
import { Input } from "../ui/input";
import { PageHeader } from "../ui/page-header";
import { AppText, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { WebText, WebView } from "../ui/web-layout";
import { BackButton, formatDate } from "./cloud-inventory";
import { useProject } from "./project-scope";
import { canManageSharing, linkIsActive, safeShareUrl } from "./project-sharing-state";
import { projectRouteFilter } from "./read-helpers";

export function ProjectSharingScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ projectId?: string | string[] }>();
	const filter = projectRouteFilter(params.projectId);
	const projectId = filter.kind === "project" ? filter.id : undefined;
	return (
		<ProjectGate key={`${scope.identity}:${scope.generation}:${projectId}`} projectId={projectId} />
	);
}

function ProjectGate({ projectId }: { projectId?: string }) {
	const t = useI18n();
	const project = useProject(projectId);
	if (
		!project.isError &&
		project.data?.id === projectId &&
		project.data &&
		canManageSharing(project.data)
	)
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

export function SharingView({
	project,
	embedded = false,
}: {
	project: Project;
	embedded?: boolean;
}) {
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
			if (!/^\S+@\S+\.\S+$/.test(email.trim())) return;
			await read((signal) =>
				sharing.invite(project.id, { email: email.trim().toLowerCase() }, signal),
			);
			if (!isCurrent()) return;
			setEmail("");
			await refresh();
		});

	const content = (
		<WebView recipe={shareProjectClasses.panels}>
			{!embedded ? (
				<PageHeader title={`Share ${project.name}`} description={SHARING_COPY.permissions} />
			) : null}
			{inventory.isError ? (
				<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
			) : null}
			{action.error ? <ApiErrorPanel error={t("sharing.failed")} /> : null}
			<WebView recipe={shareProjectClasses.section}>
				<WebView recipe={shareProjectClasses.form} className="flex-row">
					<Input
						className="flex-1"
						accessibilityLabel={t("sharing.email")}
						placeholder={SHARING_COPY.email}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="email-address"
						editable={!action.busy}
					/>
					<Button
						size="sm"
						disabled={action.busy || !/^\S+@\S+\.\S+$/.test(email.trim())}
						onPress={() => void invite()}
					>
						<Text>{SHARING_COPY.invite}</Text>
					</Button>
				</WebView>
				{inventory.isPending ? <Skeleton className="h-16" /> : null}
				{(inventory.data?.invitations ?? []).map((invitation) => (
					<WebView key={invitation.id} recipe={shareProjectClasses.row}>
						<WebView recipe={shareProjectClasses.identity}>
							<WebText recipe={shareProjectClasses.name}>{invitation.invitee_email}</WebText>
							<Badge variant="outline">
								<Text>{t("libraryPort.pending")}</Text>
							</Badge>
						</WebView>
						<Button
							variant="ghost"
							size="sm"
							disabled={action.busy}
							onPress={() =>
								confirm(t("sharing.cancelInvite"), t("sharing.cancelWarning"), (signal) =>
									sharing.cancelInvitation(project.id, invitation.id, signal),
								)
							}
						>
							<Text>{t("sharing.cancelInvite")}</Text>
						</Button>
					</WebView>
				))}
			</WebView>
			<WebView recipe={shareProjectClasses.section}>
				<WebText recipe={shareProjectClasses.heading}>{SHARING_COPY.people}</WebText>
				{inventory.isSuccess && !inventory.data.members.length ? (
					<WebText recipe={shareProjectClasses.description}>{SHARING_COPY.onlyYou}</WebText>
				) : null}
				{(inventory.data?.members ?? []).map((member) => (
					<WebView key={member.id} recipe={shareProjectClasses.row}>
						<WebView recipe={shareProjectClasses.identity}>
							<WebText recipe={shareProjectClasses.name}>
								{member.user_email ?? member.user_display ?? member.user_id}
							</WebText>
							<WebText recipe={shareProjectClasses.meta}>{member.role}</WebText>
						</WebView>
						<Button
							variant="ghost"
							size="sm"
							disabled={action.busy}
							onPress={() =>
								confirm(t("sharing.removeMember"), t("sharing.removeWarning"), (signal) =>
									sharing.removeMember(project.id, member.user_id, signal),
								)
							}
						>
							<Text>{t("sharing.removeMember")}</Text>
						</Button>
					</WebView>
				))}
			</WebView>
			<WebView recipe={shareProjectClasses.linksSection}>
				<WebView recipe={shareProjectClasses.headingRow}>
					<WebText recipe={shareProjectClasses.heading}>{SHARING_COPY.inviteLink}</WebText>
					<Button
						variant="outline"
						size="sm"
						disabled={action.busy || Boolean(freshLink)}
						onPress={() => void createLink()}
					>
						<Text>{SHARING_COPY.createLink}</Text>
					</Button>
				</WebView>
				<WebText recipe={shareProjectClasses.description}>{SHARING_COPY.linkDescription}</WebText>
				<Input
					accessibilityLabel={t("sharing.label")}
					placeholder={t("sharing.label")}
					value={label}
					onChangeText={setLabel}
					maxLength={200}
					editable={!action.busy}
				/>
				{freshLink ? (
					<WebView recipe={shareProjectClasses.section}>
						<Text>{t("sharing.once")}</Text>
						<Text selectable>{freshLink.url}</Text>
						<Button
							variant="outline"
							size="sm"
							disabled={action.busy}
							onPress={() =>
								void action.run(async () => {
									if (scope.isCurrent() && !scope.signal.aborted && focused.current)
										await Share.share({ message: freshLink.url });
								})
							}
						>
							<Text>{t("sharing.shareLink")}</Text>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onPress={() => {
								presentation.current += 1;
								setFreshLink(null);
							}}
						>
							<Text>{t("sharing.dismiss")}</Text>
						</Button>
					</WebView>
				) : null}
				{(inventory.data?.links ?? []).map((link) => (
					<WebView key={link.id} recipe={shareProjectClasses.row}>
						<WebView recipe={shareProjectClasses.identity}>
							<WebText recipe={shareProjectClasses.name}>
								{link.label ?? SHARING_COPY.inviteLink}
							</WebText>
							<WebText recipe={shareProjectClasses.linkMeta}>
								{formatDate(link.created_at)} · {link.redeem_count} {t("sharing.redemptions")}
							</WebText>
							{!linkIsActive(link) ? (
								<Badge variant="secondary">
									<Text>{t("sharing.inactive")}</Text>
								</Badge>
							) : null}
						</WebView>
						{linkIsActive(link) ? (
							<Button
								variant="ghost"
								size="sm"
								disabled={action.busy}
								onPress={() =>
									confirm(t("sharing.revoke"), t("sharing.revokeWarning"), (signal) =>
										sharing.revokeLink(project.id, link.id, signal),
									)
								}
							>
								<Text>{t("sharing.revoke")}</Text>
							</Button>
						) : null}
					</WebView>
				))}
			</WebView>
			<Button
				variant="ghost"
				size="sm"
				textClassName="text-destructive"
				disabled={action.busy}
				onPress={() =>
					confirm(t("sharing.stop"), t("sharing.stopWarning"), (signal) =>
						sharing.stopSharing(project.id, signal),
					)
				}
			>
				<Text>{SHARING_COPY.stop}</Text>
			</Button>
		</WebView>
	);
	return embedded ? (
		content
	) : (
		<LibraryPage>
			<DetailBackLink href="/projects" label={t("projects.title")} />
			{content}
		</LibraryPage>
	);
}
