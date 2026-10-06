import type { Project } from "@clawdi/shared/api";
import { shareProjectClasses } from "@clawdi/shared/ui";
import {
	canceledInvitationDescription,
	formatMembershipToken,
	projectSharingFormCopy as formCopy,
	removedMemberDescription,
	SHARING_COPY,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronRight, Link2, UserMinus } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Share } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { BackButton } from "@/components/detail/back-link";
import { useProject } from "@/components/projects/project-scope";
import {
	canManageSharing,
	linkIsActive,
	safeShareUrl,
} from "@/components/sharing/project-sharing-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState, LoadingScreen } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text as AppText, Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppPressable, AppView } from "@/components/ui/view";
import { WebText, WebView, webBoth, webText, webView } from "@/components/ui/web-layout";
import { formatDate } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { projectRouteFilter } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export function ProjectSharingScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ id?: string | string[]; projectId?: string | string[] }>();
	const filter = projectRouteFilter(params.projectId ?? params.id);
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
		<SafeAreaScreen>
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
		</SafeAreaScreen>
	);
}

function SharingView({ project, embedded = false }: { project: Project; embedded?: boolean }) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [email, setEmail] = useState("");
	const [label, setLabel] = useState("");
	const [showLabel, setShowLabel] = useState(false);
	const [manageOpen, setManageOpen] = useState(false);
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
		confirmLabel = title,
		cancelLabel: string = formCopy.cancel,
	) => {
		const scopeSignal = scope.signal;
		confirmationDialog.show(title, message, [
			{ text: cancelLabel, style: "cancel" },
			{
				text: confirmLabel,
				style: "destructive",
				className: shareProjectClasses.destructiveAction,
				onPress: () => {
					if (scopeSignal.aborted || !scope.isCurrent() || !focused.current) return;
					return action.run(async (isCurrent) => {
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
								confirm(
									formCopy.cancelTitle,
									canceledInvitationDescription(invitation.invitee_email),
									(signal) => sharing.cancelInvitation(project.id, invitation.id, signal),
									formCopy.cancelInvitation,
									formCopy.keepInvitation,
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
							<WebText recipe={shareProjectClasses.meta}>
								{formatMembershipToken(member.role)}
							</WebText>
						</WebView>
						<Button
							variant="ghost"
							size="icon"
							accessibilityLabel={formCopy.removeMember}
							disabled={action.busy}
							onPress={() =>
								confirm(
									formCopy.removeTitle,
									removedMemberDescription(
										member.user_email ?? member.user_display ?? member.user_id,
									),
									(signal) => sharing.removeMember(project.id, member.user_id, signal),
									formCopy.removeMember,
								)
							}
						>
							<Icon as={UserMinus} className={webBoth(shareProjectClasses.destructiveIcon)} />
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
						<Icon as={Link2} className={webBoth(shareProjectClasses.createLinkIcon)} />
						<Text>{SHARING_COPY.createLink}</Text>
					</Button>
				</WebView>
				<WebText recipe={shareProjectClasses.description}>{SHARING_COPY.linkDescription}</WebText>
				{showLabel ? (
					<Input
						accessibilityLabel={t("sharing.label")}
						placeholder={t("sharing.label")}
						value={label}
						onChangeText={setLabel}
						maxLength={200}
						editable={!action.busy}
					/>
				) : (
					<Button variant="ghost" size="sm" onPress={() => setShowLabel(true)}>
						<Text>{t("sharing.label")}</Text>
					</Button>
				)}
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
									confirm(
										formCopy.revokeTitle,
										formCopy.revokeDescription,
										(signal) => sharing.revokeLink(project.id, link.id, signal),
										formCopy.revoke,
									)
								}
							>
								<Text>{t("sharing.revoke")}</Text>
							</Button>
						) : null}
					</WebView>
				))}
			</WebView>
			<AppPressable
				className="flex-row items-center"
				accessibilityRole="button"
				accessibilityLabel={SHARING_COPY.manage}
				accessibilityState={{ expanded: manageOpen }}
				onPress={() => setManageOpen(!manageOpen)}
			>
				<Icon as={manageOpen ? ChevronDown : ChevronRight} />
				<WebText recipe={shareProjectClasses.manageTrigger}>{SHARING_COPY.manage}</WebText>
			</AppPressable>
			{manageOpen ? (
				<Button
					variant="ghost"
					size="sm"
					textClassName={webText(shareProjectClasses.manageAction)}
					className="self-start"
					disabled={action.busy}
					onPress={() =>
						confirm(
							formCopy.stopTitle,
							formCopy.stopDescription,
							(signal) => sharing.stopSharing(project.id, signal),
							SHARING_COPY.stop,
							formCopy.keepSharing,
						)
					}
				>
					<Text>{SHARING_COPY.stop}</Text>
				</Button>
			) : null}
			{confirmationDialog.dialog}
		</WebView>
	);
	return embedded ? (
		content
	) : (
		<SafeAreaScreen>
			<Dialog
				open
				onOpenChange={(next) => {
					if (!next && !action.busy) router.back();
				}}
			>
				<DialogContent
					className={webView(shareProjectClasses.content)}
					showCloseButton={!action.busy}
				>
					<DialogHeader>
						<DialogTitle
							className={webText(shareProjectClasses.title)}
						>{`Share ${project.name}`}</DialogTitle>
						<DialogDescription>{SHARING_COPY.permissions}</DialogDescription>
					</DialogHeader>
					{content}
				</DialogContent>
			</Dialog>
		</SafeAreaScreen>
	);
}
