import { connectorCardClasses } from "@clawdi/shared/ui";
import { connectorSearchSupportingText } from "@clawdi/shared/view";
import { Check } from "lucide-react-native";
import type { ReactNode } from "react";
import { EntityRow } from "../entity-card";
import { Icon } from "../icon";
import { webBoth, webView } from "../web-layout";
import { ConnectorIcon } from "./connector-icon";
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
			link={{ to: { pathname: "/connectors/[appName]", params: { appName: app.name } } }}
			ariaLabel={app.display_name}
		/>
	);
}
