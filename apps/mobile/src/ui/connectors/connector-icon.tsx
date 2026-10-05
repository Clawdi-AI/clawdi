import { CONNECTOR_ICON_SIZES, connectorIconClasses } from "@clawdi/shared/ui";
import { useState } from "react";
import { Image } from "react-native";
import { withUniwind } from "uniwind";
import { WebText, WebView, webView } from "../web-layout";

const AppImage = withUniwind(Image);
export function ConnectorIcon({
	logo,
	name,
	size = "md",
}: {
	logo?: string;
	name: string;
	size?: keyof typeof CONNECTOR_ICON_SIZES;
}) {
	const [failed, setFailed] = useState<string>();
	const s = CONNECTOR_ICON_SIZES[size];
	return (
		<WebView
			recipe={`${connectorIconClasses.root} ${logo && failed !== logo ? connectorIconClasses.loaded : connectorIconClasses.placeholder} ${s.box} ${s.radius}`}
		>
			{logo && failed !== logo ? (
				<AppImage
					source={{ uri: logo }}
					resizeMode="contain"
					onError={() => setFailed(logo)}
					className={webView(`${connectorIconClasses.image} ${s.pad}`)}
				/>
			) : (
				<WebText recipe={`${connectorIconClasses.letter} ${s.text}`}>
					{name
						.replace(/^[_\-\s]+/, "")
						.charAt(0)
						.toUpperCase() || "?"}
				</WebText>
			)}
		</WebView>
	);
}
