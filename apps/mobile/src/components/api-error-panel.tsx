import { ApiClientError, ApiClientNetworkError } from "@clawdi/shared/api";
import { apiErrorPanelClasses } from "@clawdi/shared/ui";
import { ACCOUNT_SUSPENDED_CODE } from "@clawdi/shared/view";
import { router } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import AlertCircle from "lucide-react-native/icons/circle-alert";
import LogIn from "lucide-react-native/icons/log-in";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
import { type Translator, useI18n } from "@/lib/i18n";

interface ApiErrorNormalizer {
	isAuthError: (error: unknown) => boolean;
	normalizeError: (error: unknown) => string;
}
/** Same Web error copy, using the shared client's error boundary and hiding internals. */
function normalizeApiError(error: unknown, t: Translator): string {
	if (error instanceof ApiClientNetworkError)
		return t(error.kind === "timeout" ? "composite.timeout" : "composite.offline");
	if (error instanceof ApiClientError) {
		// Cloud answers a suspended account with 401, hosted with 403; both carry the same code.
		if ((error.status === 401 || error.status === 403) && error.code === ACCOUNT_SUSPENDED_CODE)
			return t("composite.suspended");
		if (error.status === 401) return t("composite.expired");
		if (error.status >= 500 || error.status === 429) return t("composite.serviceError");
		return t("composite.requestError");
	}
	return t("composite.genericError");
}
export function ApiErrorPanel({
	error,
	onRetry,
	title,
	normalizer,
	icon = AlertCircle,
	onReauthenticate,
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
	normalizer?: ApiErrorNormalizer;
	icon?: LucideIcon;
	onReauthenticate?: () => void;
}) {
	const t = useI18n();
	const expired = normalizer
		? normalizer.isAuthError(error)
		: error instanceof ApiClientError && error.status === 401;
	return (
		<Alert
			variant="destructive"
			icon={icon}
			title={expired ? t("composite.expiredTitle") : (title ?? t("composite.errorTitle"))}
		>
			<AppView className={webView(apiErrorPanelClasses.description)}>
				<Text>{normalizer ? normalizer.normalizeError(error) : normalizeApiError(error, t)}</Text>
				<AppView className={webView(apiErrorPanelClasses.actions)}>
					{expired ? (
						<Button size="sm" onPress={onReauthenticate ?? (() => router.replace("/sign-in"))}>
							<Icon as={LogIn} />
							<Text>{t("composite.signInAgain")}</Text>
						</Button>
					) : null}
					{onRetry ? (
						<Button size="sm" variant="outline" onPress={onRetry}>
							<Icon as={RefreshCw} />
							<Text>{t("composite.retry")}</Text>
						</Button>
					) : null}
				</AppView>
			</AppView>
		</Alert>
	);
}
