import {
	apiKeysPanelClasses,
	authPageClasses,
	settingsPanelHeaderClasses,
} from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "../card";
import { ReadScreen } from "../read-screen";
import { AppScrollView } from "../view";
import { WebText, WebView, webView } from "../web-layout";

export function AuthFrame({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle: string;
	children: ReactNode;
}) {
	return (
		<ReadScreen>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{ flexGrow: 1 }}
				contentContainerClassName={`${webView(authPageClasses.main)} px-5 py-8`}
			>
				<Card className={webView(authPageClasses.cardBox)}>
					<CardHeader>
						<WebView recipe={settingsPanelHeaderClasses.copy} className="items-center">
							<WebText recipe={settingsPanelHeaderClasses.title}>{title}</WebText>
							<WebText recipe={settingsPanelHeaderClasses.description} className="text-center">
								{subtitle}
							</WebText>
						</WebView>
					</CardHeader>
					<CardContent>
						<WebView recipe={apiKeysPanelClasses.form}>{children}</WebView>
					</CardContent>
				</Card>
			</AppScrollView>
		</ReadScreen>
	);
}
