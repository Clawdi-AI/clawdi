import { dashboardPageClasses as page, onboardingCardClasses as styles } from "@clawdi/shared/ui";
import { OVERVIEW_COPY, onboardingCardModel } from "@clawdi/shared/view";
import { router } from "expo-router";
import { Rocket, TerminalSquare } from "lucide-react-native";
import { Button } from "../button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";
import { Text } from "../text";
import { WebIcon, WebText, WebView, webView } from "../web-layout";
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
				<WebView recipe={styles.flexItemsCenterGap2} className="flex-row">
					<WebIcon as={Rocket} recipe={styles.size5TextPrimary} />
					<CardTitle>{title}</CardTitle>
				</WebView>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				<WebView recipe={styles.gridGap2}>
					{canDeployOnClawdi ? (
						<Button
							size="lg"
							className={webView(styles.wFull)}
							onPress={() => router.push("/agents/new")}
						>
							<WebIcon as={Rocket} recipe={styles.size5TextPrimary} />
							<Text>{OVERVIEW_COPY.deploy}</Text>
						</Button>
					) : null}
					<Button
						variant={canDeployOnClawdi ? "outline" : "default"}
						size="lg"
						className={webView(styles.hAutoMinH10)}
						onPress={() => router.push("/agents/new")}
					>
						<WebIcon as={TerminalSquare} recipe={styles.size5TextPrimary} />
						<Text>{OVERVIEW_COPY.connect}</Text>
					</Button>
				</WebView>
			</CardContent>
		</Card>
	);
}
export function ConnectAnotherCard() {
	return (
		<Card className={webView(page.py4)}>
			<CardContent className={`${webView(page.flexItemsCenterJustifyBetween)} flex-col`}>
				<WebText recipe={page.minW0TextSm}>{OVERVIEW_COPY.connectAnother}</WebText>
				<Button size="sm" variant="outline" onPress={() => router.push("/agents/new")}>
					<Text>{OVERVIEW_COPY.addAgent}</Text>
				</Button>
			</CardContent>
		</Card>
	);
}
