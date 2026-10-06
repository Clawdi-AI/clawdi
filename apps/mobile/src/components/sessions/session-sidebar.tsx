import { markdownExternalUrl } from "@clawdi/shared/markdown";
import { sessionSidebarClasses as styles } from "@clawdi/shared/ui";
import { sessionPullRequestUrl, sessionRepositoryUrl } from "@clawdi/shared/view";
import { openBrowserAsync } from "expo-web-browser";
import { GitBranch, GitPullRequest, Package } from "lucide-react-native";
import { Alert } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Icon } from "@/components/ui/icon";
import { WebText, WebView, webBoth, webText } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";
/** Related refs use the same compact phone layout; selectable paths remain native. */
export function SessionSidebar({
	relatedRefs,
}: {
	relatedRefs?: {
		prs?: string[] | null;
		repos?: string[] | null;
		branches?: string[] | null;
	} | null;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope);
	const open = (value: string | undefined) => {
		const url = value ? markdownExternalUrl(value) : null;
		if (!url || action.busy) return;
		const visible = capture();
		Alert.alert(t("markdown.openLink"), url, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("markdown.openLink"),
				onPress: () => {
					void action.run(async (current) => {
						if (current() && visible() && scope.isCurrent()) await openBrowserAsync(url);
					});
				},
			},
		]);
	};
	const prs = relatedRefs?.prs ?? [],
		repos = relatedRefs?.repos ?? [],
		branches = relatedRefs?.branches ?? [];
	if (!prs.length && !repos.length && !branches.length) return null;
	return (
		<WebView recipe={styles.root}>
			{prs.slice(0, 5).map((pr) => (
				<WebView recipe={styles.chip} key={`pr-${pr}`}>
					<Icon as={GitPullRequest} className={webBoth(styles.icon)} />
					<WebText
						recipe={`${webText(styles.chip)} ${styles.mono}`}
						selectable
						onPress={() => open(sessionPullRequestUrl(pr))}
					>
						{pr}
					</WebText>
				</WebView>
			))}
			{prs.length > 5 ? (
				<WebView recipe={styles.chip}>
					<Icon as={GitPullRequest} />
					<WebText recipe={webText(styles.chip)}>+{prs.length - 5} more</WebText>
				</WebView>
			) : null}
			{repos.slice(0, 3).map((repo) => (
				<WebView recipe={styles.chip} key={`repo-${repo}`}>
					<Icon as={Package} className={webBoth(styles.icon)} />
					<WebText
						recipe={`${webText(styles.chip)} ${styles.mono}`}
						selectable
						onPress={() => open(sessionRepositoryUrl(repo))}
					>
						{repo}
					</WebText>
				</WebView>
			))}
			{branches.slice(0, 3).map((branch) => (
				<WebView recipe={styles.chip} key={`branch-${branch}`}>
					<Icon as={GitBranch} className={webBoth(styles.icon)} />
					<WebText recipe={`${webText(styles.chip)} ${styles.mono}`} selectable>
						{branch}
					</WebText>
				</WebView>
			))}
			{action.error ? <ApiErrorPanel error={null} /> : null}
		</WebView>
	);
}
