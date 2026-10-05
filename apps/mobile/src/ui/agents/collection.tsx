import { agentsIndexClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { PageHeader } from "../page-header";
import { AppScrollView } from "../primitives";
import { ReadScreen } from "../read-screen";
import { webView } from "../web-layout";
export function AgentCollection({
	title,
	description,
	actions,
	navigation,
	children,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
	navigation?: ReactNode;
	children: ReactNode;
}) {
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				{navigation}
				<PageHeader title={title} description={description} actions={actions} />
				{children}
			</AppScrollView>
		</ReadScreen>
	);
}
