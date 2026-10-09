import { agentFrameworkIconClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import Laptop from "lucide-react-native/icons/laptop";
import { useState } from "react";
import { Image } from "react-native";
import { withUniwind } from "uniwind";
import { BrandIconTile } from "@/components/brand-icon-tile";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebView, webText, webView } from "@/components/ui/web-layout";

const AppImage = withUniwind(Image);
export function AgentFrameworkIcon({
	agent,
	label,
	alt = "",
	pixelSize,
	boxClassName,
	fallbackIconClassName,
	fallback = "device",
	avatarUrl,
	className,
}: {
	agent: string | null | undefined;
	label?: string | null;
	alt?: string;
	pixelSize: number;
	boxClassName: string;
	fallbackIconClassName?: string;
	fallback?: "device" | "monogram";
	avatarUrl?: string | null;
	className?: string;
	draggable?: boolean;
}) {
	const [failedUrl, setFailedUrl] = useState<string>();
	const customAvatar = avatarUrl?.trim();
	if (customAvatar && failedUrl !== customAvatar)
		return (
			<AppImage
				source={{ uri: customAvatar }}
				accessibilityLabel={alt}
				onError={() => setFailedUrl(customAvatar)}
				style={{ width: pixelSize, height: pixelSize }}
				className={cn(boxClassName, webView(styles.customImage), className)}
			/>
		);
	const brand = frameworkBrandIcon(agent);
	if (brand)
		return (
			<BrandIconTile
				icon={brand.icon}
				iconClassName={brand.iconClassName}
				iconScale={brand.iconScale}
				label={alt || brand.label}
				boxClassName={boxClassName}
				className={cn(brand.tileClassName, className)}
			/>
		);
	return (
		<WebView recipe={cn(boxClassName, styles.fallback, className)}>
			{fallback === "monogram" ? (
				<Text className={webText(styles.fallback)}>
					{(label ?? agent ?? "").trim().charAt(0).toUpperCase() || "?"}
				</Text>
			) : (
				<Icon as={Laptop} className={cn(webText(styles.fallback), fallbackIconClassName)} />
			)}
		</WebView>
	);
}
