import { accountSuspendedPageClasses as styles } from "@clawdi/shared/ui";
import { accountSuspendedCopy as copy } from "@clawdi/shared/view";
import { LogOut, Mail, ShieldOff } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppImage, AppScrollView } from "@/components/ui/view";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";

const logo = require("../../assets/splash-icon.png");

/** apps/web/src/components/account-suspended-page.tsx: same copy, order and exits. */
export function AccountSuspendedPage({
	onContactSupport,
	onSignOut,
	signingOut = false,
	error = null,
}: {
	onContactSupport: () => void;
	onSignOut: () => void;
	signingOut?: boolean;
	error?: string | null;
}) {
	return (
		<AppScrollView
			testID="account-suspended-screen"
			className="flex-1 bg-background"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName={webView(`${styles.page} grow`)}
		>
			<WebView recipe={styles.section}>
				<AppImage
					source={logo}
					accessibilityLabel="Clawdi"
					className={webView(styles.logo)}
					resizeMode="contain"
				/>
				<WebView recipe={styles.iconChip}>
					<WebIcon as={ShieldOff} recipe={styles.icon} />
				</WebView>
				<WebText recipe={styles.title} accessibilityRole="header">
					{copy.title}
				</WebText>
				<WebText recipe={styles.reason}>{copy.reason}</WebText>
				<WebText recipe={styles.help}>{copy.help}</WebText>
				<WebView recipe={styles.actions}>
					<Button onPress={onContactSupport}>
						<Icon as={Mail} />
						<Text>{copy.contactSupport}</Text>
					</Button>
					<Button variant="outline" disabled={signingOut} onPress={onSignOut}>
						{signingOut ? <Spinner label={copy.signingOut} /> : <Icon as={LogOut} />}
						<Text>{signingOut ? copy.signingOut : copy.signOut}</Text>
					</Button>
				</WebView>
				{error ? (
					<WebText recipe={styles.error} accessibilityRole="alert">
						{error}
					</WebText>
				) : null}
			</WebView>
		</AppScrollView>
	);
}
