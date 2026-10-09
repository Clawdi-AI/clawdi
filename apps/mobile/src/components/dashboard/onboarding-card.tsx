import { dashboardPageClasses as page, onboardingCardClasses as styles } from "@clawdi/shared/ui";
import { OVERVIEW_COPY, onboardingCardModel } from "@clawdi/shared/view";
import { router } from "expo-router";
import Rocket from "lucide-react-native/icons/rocket";
import TerminalSquare from "lucide-react-native/icons/square-terminal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";
export function OnboardingCard({
	variant = "first-agent",
	canDeployOnClawdi = false,
}: {
	variant?: "first-agent" | "additional-agent";
	canDeployOnClawdi?: boolean;
}) {
	const { title, description } = onboardingCardModel(variant, canDeployOnClawdi);
	return (
		<Card>
			<CardHeader>
				<WebView recipe={styles.title} className="flex-row">
					<WebIcon as={Rocket} recipe={styles.titleIcon} />
					<CardTitle>{title}</CardTitle>
				</WebView>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				<WebView recipe={styles.actions}>
					{canDeployOnClawdi ? (
						<Button
							size="lg"
							className={webView(styles.deployAction)}
							onPress={() => router.push("/deploy")}
						>
							<WebIcon as={Rocket} recipe={styles.titleIcon} />
							<Text>{OVERVIEW_COPY.deploy}</Text>
						</Button>
					) : null}
					<Button
						variant={canDeployOnClawdi ? "outline" : "default"}
						size="lg"
						className={webView(styles.connectAction)}
						onPress={() => router.push("/deploy")}
					>
						<WebIcon as={TerminalSquare} recipe={styles.titleIcon} />
						<Text>{OVERVIEW_COPY.connect}</Text>
					</Button>
				</WebView>
			</CardContent>
		</Card>
	);
}
export function ConnectAnotherCard() {
	return (
		<Card className={webView(page.connectCard)}>
			<CardContent className={`${webView(page.connectCardContent)} flex-col`}>
				<WebText recipe={page.connectCardTitle}>{OVERVIEW_COPY.connectAnother}</WebText>
				<Button size="sm" variant="outline" onPress={() => router.push("/deploy")}>
					<Text>{OVERVIEW_COPY.addAgent}</Text>
				</Button>
			</CardContent>
		</Card>
	);
}
