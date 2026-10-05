import type { components } from "@clawdi/shared/api";
import { identityFor } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Button } from "../ui/button";
import { DetailBackLink, LibraryPage } from "../ui/detail/layout";
import { EmptyState } from "../ui/empty-state";
import { HeroCard, HeroCardSkeleton } from "../ui/entity-card";
import { IconChip } from "../ui/icon-chip";
import { PageHeader } from "../ui/page-header";
import { Text } from "../ui/text";
import { useConfirmation } from "../ui/use-confirmation";

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
						return action.run(async (isCurrent) => {
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
		<LibraryPage>
			<DetailBackLink href="/projects" label={t("projects.title")} />
			<PageHeader title={t("sharing.received")} description={t("sharing.receivedDescription")} />
			{invitations.error ? (
				<ApiErrorPanel error={invitations.error} onRetry={() => void invitations.refetch()} />
			) : null}
			{action.error ? <ApiErrorPanel error={t("sharing.responseFailed")} /> : null}
			{invitations.isPending ? (
				<HeroCardSkeleton />
			) : (
				invitations.data?.map((invitation) => (
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
				))
			)}
			{invitations.isSuccess && !invitations.data.length ? (
				<EmptyState description={t("sharing.noInvitations")} />
			) : null}
			{confirmationDialog.dialog}
		</LibraryPage>
	);
}
