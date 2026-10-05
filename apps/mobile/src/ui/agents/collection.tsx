import { agentsIndexClasses, connectedAgentDetailClasses } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { PageHeader } from "../page-header";
import { AppScrollView } from "../primitives";
import { ReadScreen } from "../read-screen";
import { WebIcon, webView } from "../web-layout";
export function AgentCollection({
	title,
	icon,
	description,
	actions,
	navigation,
	children,
}: {
	title: string;
	icon?: LucideIcon;
	description?: string;
	actions?: ReactNode;
	navigation?: ReactNode;
	children: ReactNode;
}) {
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				{navigation}
				<PageHeader
					title={title}
					description={description}
					actions={actions}
					icon={
						icon ? (
							<WebIcon as={icon} recipe={connectedAgentDetailClasses.sizeTextMutedForeground} />
						) : undefined
					}
				/>
				{children}
			</AppScrollView>
		</ReadScreen>
	);
}
