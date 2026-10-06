import type { SessionTimelineRow } from "@clawdi/shared/api";
import { router } from "expo-router";
import { Share } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SessionTimelineRowView } from "@/components/sessions/message-list";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useCurrentUser } from "@/platform/auth/auth-client";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";
export function TimelineRow({
	row,
	sessionId,
	highlighted,
	query,
	disabled,
	agentType,
}: {
	row: SessionTimelineRow;
	sessionId: string;
	highlighted: boolean;
	query?: string;
	disabled: boolean;
	agentType?: string | null;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope);
	const { user } = useCurrentUser();
	return (
		<>
			<SessionTimelineRowView
				row={row}
				agentType={agentType}
				userName={user?.fullName || "You"}
				highlighted={highlighted}
				query={query}
				disabled={disabled || action.busy}
				onShareText={(content) => {
					const visible = capture();
					void action.run(async (current) => {
						if (current() && visible() && scope.isCurrent())
							await Share.share({ message: content });
					});
				}}
				onShareMessage={(target) => {
					if (scope.isCurrent())
						router.push({
							pathname: "/sessions/shared",
							params: { sessionId, scope: target.scope, position: String(target.position) },
						});
				}}
			/>
			{action.error ? <ApiErrorPanel error={null} title={t("sessionDetail.failed")} /> : null}
		</>
	);
}
