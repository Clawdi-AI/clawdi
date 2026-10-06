import { CONNECTOR_ICON_SIZES, connectorIconClasses } from "@clawdi/shared/ui";
import { useCallback, useState } from "react";
import { Image } from "react-native";
import { SvgUri } from "react-native-svg";
import { withUniwind } from "uniwind";
import { WebText, WebView, webView } from "@/components/ui/web-layout";

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
	const [imageState, setImageState] = useState<{
		src?: string;
		status: "loaded" | "svg" | "error";
	}>();
	const loaded = imageState?.src === logo && imageState?.status === "loaded";
	const svg = imageState?.src === logo && imageState?.status === "svg";
	const failed = imageState?.src === logo && imageState?.status === "error";
	const onLoad = useCallback(() => setImageState({ src: logo, status: "loaded" }), [logo]);
	const onSvgError = useCallback(() => setImageState({ src: logo, status: "error" }), [logo]);
	const [svgSource, setSvgSource] = useState<string>();
	const s = CONNECTOR_ICON_SIZES[size];
	return (
		<WebView
			recipe={`${connectorIconClasses.root} ${loaded ? connectorIconClasses.loaded : connectorIconClasses.placeholder} ${s.box} ${s.radius}`}
		>
			{!loaded ? (
				<WebText recipe={`${connectorIconClasses.letter} ${s.text}`}>
					{name
						.replace(/^[_\-\s]+/, "")
						.charAt(0)
						.toUpperCase() || "?"}
				</WebText>
			) : null}
			{logo && !failed && svgSource === logo ? (
				<WebView recipe={`${connectorIconClasses.image} ${s.pad}`}>
					<SvgUri uri={logo} width="100%" height="100%" onLoad={onLoad} onError={onSvgError} />
				</WebView>
			) : logo && !failed && !svg ? (
				<AppImage
					source={{ uri: logo }}
					resizeMode="contain"
					onLoad={onLoad}
					onError={() => {
						setSvgSource(logo);
						setImageState({ src: logo, status: "svg" });
					}}
					className={webView(`${connectorIconClasses.image} ${s.pad}`)}
				/>
			) : null}
		</WebView>
	);
}
