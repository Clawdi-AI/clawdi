import { connectorCardClasses } from "@clawdi/shared/ui";
import { connectorSearchSupportingText } from "@clawdi/shared/view";
import Check from "lucide-react-native/icons/check";
import type { ReactNode } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { EntityRow } from "@/components/entity-card";
import { Icon } from "@/components/ui/icon";
import { webBoth, webView } from "@/components/ui/web-layout";
import { useAgentRouteId } from "@/platform/navigation/use-agent-route";
export function ConnectorCard({
	app,
	isConnected = false,
	searchQuery,
	actions,
}: {
	app: { name: string; display_name: string; description: string; logo?: string };
	isConnected?: boolean;
	searchQuery?: string;
	actions?: ReactNode;
}) {
	const agentId = useAgentRouteId();
	return (
		<EntityRow
			className={webView(connectorCardClasses.root)}
			icon={<ConnectorIcon name={app.display_name} logo={app.logo} />}
			title={app.display_name}
			titleAdornment={
				isConnected ? (
					<Icon as={Check} className={webBoth(connectorCardClasses.connectedIcon)} />
				) : undefined
			}
			meta={searchQuery ? connectorSearchSupportingText(app, searchQuery) : app.description}
			actions={actions}
			link={{
				to: agentId
					? { pathname: "/agents/[id]/connectors/[name]", params: { id: agentId, name: app.name } }
					: { pathname: "/connectors/[name]", params: { name: app.name } },
			}}
			ariaLabel={app.display_name}
		/>
	);
}
