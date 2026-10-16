import { ApiClientError } from "@clawdi/shared/api";
import { projectSharePageClasses as styles } from "@clawdi/shared/ui";
import {
	projectInvitationCopy as copy,
	type ProjectShareErrorCode,
	projectInvitationAccess,
	projectInvitationCounts,
	projectShareErrorCopy,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import AlertCircle from "lucide-react-native/icons/circle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check";
import Sparkles from "lucide-react-native/icons/sparkles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Separator } from "@/components/ui/separator";
import { SheetPage } from "@/components/ui/sheet-page";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";

/** Web's `/share/:token` landing page; the token arrives only through the link. */
export function ProjectShareScreen() {
	const scope = useAccountScope();
	const { token } = useLocalSearchParams<{ token?: string }>();
	const valid = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
	return <ProjectShare key={`${scope.identity}:${scope.generation}:${token}`} token={valid} />;
}

function shareErrorCode(error: unknown): ProjectShareErrorCode {
	if (!(error instanceof ApiClientError)) return "unknown";
	if (error.status === 404) return "not_found";
	if (error.status === 410) return "revoked";
	// The shared transport keeps only `code`; Web's owner case reads `detail.error`.
	if (error.status === 409) return "already_member";
	return "unknown";
}

function ProjectShare({ token }: { token: string | null }) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const preview = useQuery({
		// The capability token stays out of query keys.
		queryKey: accountQueryKey(scope, "project-share-preview"),
		queryFn: ({ signal }) => read((s) => sharing.previewLink(token ?? "", s), signal),
		enabled: scope.isReady && Boolean(token),
		retry: false,
		gcTime: 0,
	});
	const accept = () =>
		action.run(async (current) => {
			if (!token) return;
			const joined = await read((s) => sharing.joinLink(token, s));
			if (!current()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			if (current())
				router.replace({ pathname: "/projects/[id]", params: { id: joined.project_id } });
		});
	const failure = !token
		? projectShareErrorCopy("not_found")
		: preview.error
			? projectShareErrorCopy(shareErrorCode(preview.error))
			: null;
	const acceptFailure = action.error ? shareErrorCode(action.failure) : null;
	const data = preview.data;
	return (
		<SheetPage title={copy.title} fallback="/projects" busy={action.busy}>
			{failure ? (
				<Alert variant="destructive" icon={AlertCircle} title={failure.title}>
					{failure.description}
				</Alert>
			) : !data ? (
				<Skeleton className="h-64 w-full" />
			) : (
				<Card>
					<CardHeader>
						<WebView recipe={styles.invitation} className="flex-row">
							<Icon as={Sparkles} />
							<WebText recipe={styles.invitation}>{copy.title}</WebText>
						</WebView>
						<CardTitle className={webView(styles.title)}>{data.project_name}</CardTitle>
						<WebText recipe={styles.description}>
							{copy.sharedBy}
							<WebText recipe={styles.owner}>{data.owner_display}</WebText>{" "}
							<WebText recipe={styles.handle}>@{data.owner_handle}</WebText>
						</WebText>
					</CardHeader>
					<CardContent className={webView(styles.body)}>
						<WebText recipe={styles.description}>
							{projectInvitationCounts(data.skill_count, data.vault_count)}
						</WebText>
						<WebText recipe={styles.description}>
							{projectInvitationAccess(data.vault_count > 0)}
						</WebText>
						<Separator />
						<Button
							className={webView(styles.action)}
							size="lg"
							disabled={action.busy}
							onPress={() => void accept()}
						>
							<Icon as={CheckCircle2} />
							<Text>{action.busy ? copy.joining : copy.accept}</Text>
						</Button>
						{acceptFailure === "already_member" ? (
							<Alert icon={CheckCircle2}>{copy.alreadyAccess}</Alert>
						) : acceptFailure ? (
							<Alert variant="destructive" icon={AlertCircle}>
								{projectShareErrorCopy(acceptFailure).description}
							</Alert>
						) : null}
					</CardContent>
				</Card>
			)}
		</SheetPage>
	);
}
