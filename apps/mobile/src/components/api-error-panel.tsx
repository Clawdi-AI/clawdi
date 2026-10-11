import { ApiClientError } from "@clawdi/shared/api";
import { apiErrorPanelClasses } from "@clawdi/shared/ui";
import { API_ERROR_COPY, apiErrorCopy } from "@clawdi/shared/view";
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
import { requestFailure } from "@/lib/request-failure";

interface ApiErrorNormalizer {
	isAuthError: (error: unknown) => boolean;
	normalizeError: (error: unknown) => string;
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
	const expired = normalizer
		? normalizer.isAuthError(error)
		: error instanceof ApiClientError && error.status === 401;
	return (
		<Alert
			variant="destructive"
			icon={icon}
			title={expired ? API_ERROR_COPY.expiredTitle : (title ?? API_ERROR_COPY.errorTitle)}
		>
			<AppView className={webView(apiErrorPanelClasses.description)}>
				<Text>
					{normalizer ? normalizer.normalizeError(error) : apiErrorCopy(requestFailure(error))}
				</Text>
				<AppView className={webView(apiErrorPanelClasses.actions)}>
					{expired ? (
						<Button size="sm" onPress={onReauthenticate ?? (() => router.replace("/sign-in"))}>
							<Icon as={LogIn} />
							<Text>{API_ERROR_COPY.signInAgain}</Text>
						</Button>
					) : null}
					{onRetry ? (
						<Button size="sm" variant="outline" onPress={onRetry}>
							<Icon as={RefreshCw} />
							<Text>{API_ERROR_COPY.retry}</Text>
						</Button>
					) : null}
				</AppView>
			</AppView>
		</Alert>
	);
}
