import { newAgentChooserClasses as styles } from "@clawdi/shared/ui";
import { newAgentChooserCopy as copy } from "@clawdi/shared/view";
import { cn } from "cn";
import { type Href, router } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import Rocket from "lucide-react-native/icons/rocket";
import TerminalSquare from "lucide-react-native/icons/square-terminal";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SheetPage } from "@/components/ui/sheet-page";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useProductCapabilities } from "@/hooks/use-dashboard-agents";
import { useMobileApi } from "@/lib/api-provider";
import type { HeaderAction } from "@/platform/navigation/native-header-types";
import { useSheet } from "@/platform/navigation/use-sheet";

const CONNECT_HREF = "/agents/connect" satisfies Href;

/** Web's sidebar access check: hosted builds may deploy only with Cloud Agent access. */
function useNewAgentAccess() {
	const { compute } = useMobileApi();
	const capabilities = useProductCapabilities();
	const hosted = Boolean(compute);
	return {
		capabilities,
		canDeployOnClawdi: hosted && capabilities.data?.can_use_v2 === true,
		checking: hosted && capabilities.isPending,
		accessError: hosted && capabilities.isError,
	};
}

/**
 * Web's "New agent" button as a header action: the chooser when Cloud Agents can be deployed
 * (or access couldn't be checked), otherwise straight to connecting an agent.
 */
export function useNewAgentAction(): HeaderAction {
	const { canDeployOnClawdi, checking, accessError } = useNewAgentAccess();
	return {
		id: "new-agent",
		label: copy.title,
		disabled: checking,
		onPress: () => router.push(canDeployOnClawdi || accessError ? "/agents/new" : CONNECT_HREF),
	};
}

/** Web's chooser dialog as a native sheet. */
export function NewAgentChooserScreen() {
	const { capabilities, canDeployOnClawdi, checking, accessError } = useNewAgentAccess();
	const sheet = useSheet({ fallback: "/agents" });
	return (
		<SheetPage
			title={copy.title}
			description={copy.description(canDeployOnClawdi)}
			fallback="/agents"
			sheet={sheet}
		>
			{accessError ? (
				<ApiErrorPanel
					error={capabilities.error}
					onRetry={() => void capabilities.refetch()}
					title={copy.accessError}
				/>
			) : null}
			<WebView recipe={cn(styles.choices, canDeployOnClawdi && styles.choicesWithDeploy)}>
				{canDeployOnClawdi || checking ? (
					<ChoiceCard
						icon={Rocket}
						title={checking ? copy.checkingAccess : copy.deployTitle}
						description={copy.deployDescription}
						disabled={!canDeployOnClawdi}
						onPress={() => void sheet.close().then(() => router.push("/deploy"))}
					/>
				) : null}
				<ChoiceCard
					icon={TerminalSquare}
					title={copy.connectTitle}
					description={copy.connectDescription}
					onPress={() => router.replace(CONNECT_HREF)}
				/>
			</WebView>
		</SheetPage>
	);
}

function ChoiceCard({
	icon,
	title,
	description,
	disabled,
	onPress,
}: {
	icon: LucideIcon;
	title: string;
	description: string;
	disabled?: boolean;
	onPress: () => void;
}) {
	return (
		<Button variant="outline" className={styles.choice} disabled={disabled} onPress={onPress}>
			<IconChip size="sm" tint={styles.chipTint} className={webView(styles.chip)}>
				<Icon as={icon} />
			</IconChip>
			<WebText recipe={styles.title}>{title}</WebText>
			<WebText recipe={styles.description}>{description}</WebText>
		</Button>
	);
}
