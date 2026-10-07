import type { components } from "@clawdi/shared/api";
import { identityFor } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebText } from "@/components/ui/web-layout";
import { usePullRefresh } from "@/hooks/use-pull-refresh";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";

export function ProjectInvitationsScreen() {
	const scope = useAccountScope();
	return <InvitationsView key={`${scope.identity}:${scope.generation}`} />;
}

function InvitationsView() {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const invitations = useQuery({
		queryKey: accountQueryKey(scope, "received-invitations"),
		queryFn: ({ signal }) =>
			read((requestSignal) => sharing.listReceivedInvitations(requestSignal), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const pull = usePullRefresh(() => invitations.refetch());
	const respond = (invitation: components["schemas"]["InvitationResponse"], accept: boolean) => {
		const signal = scope.signal;
		confirmationDialog.show(
			t(accept ? "sharing.accept" : "sharing.decline"),
			invitation.project_name,
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t(accept ? "sharing.accept" : "sharing.decline"),
					style: accept ? "default" : "destructive",
					onPress: () => {
						if (signal.aborted || !scope.isCurrent()) return;
						return action.runOrThrow(async (isCurrent) => {
							await read(async (requestSignal) => {
								if (accept) await sharing.acceptInvitation(invitation.id, requestSignal);
								else await sharing.declineInvitation(invitation.id, requestSignal);
							}, signal);
							if (isCurrent()) await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
						});
					},
				},
			],
		);
	};

	return (
		<SheetPage title={t("sharing.received")} scroll={false} fallback="/projects" busy={action.busy}>
			<NativeList
				data={invitations.data ?? []}
				keyExtractor={(invitation) => invitation.id}
				refreshing={pull.refreshing}
				onRefresh={pull.onRefresh}
				header={
					<>
						<WebText recipe="text-sm text-muted-foreground">
							{t("sharing.receivedDescription")}
						</WebText>
						{invitations.error ? (
							<ApiErrorPanel error={invitations.error} onRetry={() => void invitations.refetch()} />
						) : null}
						{action.error ? <ApiErrorPanel error={t("sharing.responseFailed")} /> : null}
					</>
				}
				renderItem={({ item: invitation }) => (
					<HeroCard
						key={invitation.id}
						title={invitation.project_name}
						icon={
							<IconChip tint={identityFor(invitation.project_name).colorClasses}>
								{identityFor(invitation.project_name).emoji}
							</IconChip>
						}
						description={invitation.owner_display}
						actionsVisibility="always"
						actions={
							<>
								<Button size="sm" disabled={action.busy} onPress={() => respond(invitation, true)}>
									<Text>{t("sharing.accept")}</Text>
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={action.busy}
									onPress={() => respond(invitation, false)}
								>
									<Text>{t("sharing.decline")}</Text>
								</Button>
							</>
						}
					/>
				)}
				empty={
					invitations.isPending ? (
						<HeroCardSkeleton />
					) : !invitations.error ? (
						<EmptyState description={t("sharing.noInvitations")} />
					) : null
				}
			/>
			{confirmationDialog.dialog}
		</SheetPage>
	);
}
