import type { components } from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";

export function ProjectInvitationsScreen() {
	const scope = useAccountScope();
	return <InvitationsView key={`${scope.identity}:${scope.generation}`} />;
}

function InvitationsView() {
	const t = useI18n();
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
		Alert.alert(t(accept ? "sharing.accept" : "sharing.decline"), invitation.project_name, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t(accept ? "sharing.accept" : "sharing.decline"),
				style: accept ? "default" : "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent()) return;
					void action.run(async (isCurrent) => {
						await read(async (requestSignal) => {
							if (accept) await sharing.acceptInvitation(invitation.id, requestSignal);
							else await sharing.declineInvitation(invitation.id, requestSignal);
						}, signal);
						if (isCurrent()) await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
					});
				},
			},
		]);
	};
	return (
		<InventoryList
			title={t("sharing.received")}
			description={t("sharing.receivedDescription")}
			items={invitations.data ?? []}
			empty={t(invitations.isPending ? "loading.app" : "sharing.noInvitations")}
			refreshing={invitations.isRefetching}
			onRefresh={() => {
				if (!invitations.isFetching) void invitations.refetch();
			}}
			error={invitations.isError}
			onRetry={() => void invitations.refetch()}
			busy={invitations.isFetching}
			header={
				action.error ? (
					<AppText accessibilityRole="alert">{t("sharing.responseFailed")}</AppText>
				) : undefined
			}
			renderItem={(invitation) => (
				<AppView className="gap-3 rounded-2xl bg-card p-4">
					<AppText className="text-lg text-foreground">{invitation.project_name}</AppText>
					<AppText>{invitation.owner_display}</AppText>
					<NativeButton
						label={t("sharing.accept")}
						disabled={action.busy}
						onPress={() => respond(invitation, true)}
					/>
					<NativeButton
						label={t("sharing.decline")}
						disabled={action.busy}
						onPress={() => respond(invitation, false)}
					/>
				</AppView>
			)}
		/>
	);
}
