import { providerDialogClasses as styles } from "@clawdi/shared/ui";
import { ArrowLeft } from "lucide-react-native";
import { Button } from "../button";
import { DialogHeader, DialogTitle } from "../dialog";
import { EntityIcon } from "../entity-icon";
import { Icon } from "../icon";
import { WebView, webView } from "../web-layout";

export function ProviderDialogHeader({
	title,
	providerId,
	providerLabel,
	onBack,
	disabled,
}: {
	title: string;
	providerId?: string;
	providerLabel?: string;
	onBack?: () => void;
	disabled?: boolean;
}) {
	return (
		<DialogHeader className={webView(styles.header)}>
			<WebView recipe={styles.headerRow} className="flex-row">
				{onBack ? (
					<Button
						variant="ghost"
						size="icon-sm"
						accessibilityLabel="Back"
						disabled={disabled}
						onPress={onBack}
						className={webView(styles.icon)}
					>
						<Icon as={ArrowLeft} />
					</Button>
				) : null}
				<WebView recipe={styles.titleRow} className="flex-row flex-1">
					{providerId ? (
						<EntityIcon kind="provider" id={providerId} label={providerLabel ?? title} size="md" />
					) : null}
					<DialogTitle className={`${webView(styles.title)} flex-1`}>{title}</DialogTitle>
				</WebView>
			</WebView>
		</DialogHeader>
	);
}
