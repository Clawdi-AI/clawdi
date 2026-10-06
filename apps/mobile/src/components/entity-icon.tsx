import { entityIconClasses } from "@clawdi/shared/ui";
import { cn } from "cn";
import { useState } from "react";
import { Image } from "react-native";
import { withUniwind } from "uniwind";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { BrandIconTile } from "@/components/brand-icon-tile";
import { providerBrandIcon } from "@/components/entity-brand-icons";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { webText, webView } from "@/components/ui/web-layout";

const AppImage = withUniwind(Image);
const CHANNEL_PNG: Readonly<Record<string, string>> = Object.fromEntries(
	["telegram", "discord", "whatsapp", "slack"].map((id) => [
		id,
		`https://assets.clawdi.ai/icons/${id}.png`,
	]),
);
const SIZE = {
	sm: {
		px: 24,
		box: webView(entityIconClasses.smallTile),
		mono: webText(entityIconClasses.smallMonogram),
	},
	md: {
		px: 40,
		box: webView(entityIconClasses.mediumTile),
		mono: webText(entityIconClasses.mediumMonogram),
	},
	lg: {
		px: 48,
		box: webView(entityIconClasses.largeTile),
		mono: webText(entityIconClasses.largeMonogram),
	},
} as const;
export type EntityIconSize = keyof typeof SIZE;
export type EntityKind = "channel" | "provider" | "framework";
export function EntityIcon({
	kind,
	id,
	label,
	size = "md",
	className,
}: {
	kind: EntityKind;
	id: string;
	label?: string;
	size?: EntityIconSize;
	className?: string;
}) {
	const s = SIZE[size],
		key = id.toLowerCase(),
		brand = kind === "provider" ? providerBrandIcon(key) : undefined,
		alt = label ?? brand?.label ?? id;
	const [failedUrl, setFailedUrl] = useState<string>();
	if (kind === "framework")
		return (
			<AgentFrameworkIcon
				agent={id}
				label={alt}
				alt={alt}
				pixelSize={s.px}
				boxClassName={s.box}
				fallback="monogram"
				className={cn(s.mono, className)}
			/>
		);
	const png = kind === "channel" ? CHANNEL_PNG[key] : undefined;
	if (png && failedUrl !== png)
		return (
			<AppImage
				source={{ uri: png }}
				accessibilityLabel={alt}
				onError={() => setFailedUrl(png)}
				className={cn(s.box, webView(entityIconClasses.channelImage), className)}
			/>
		);
	if (brand)
		return (
			<BrandIconTile
				icon={brand.icon}
				iconClassName={brand.iconClassName}
				iconScale={brand.iconScale}
				label={alt}
				boxClassName={s.box}
				className={cn(brand.tileClassName, className)}
			/>
		);
	return (
		<AppView
			className={cn(
				s.box,
				webView(entityIconClasses.monogram),
				kind === "provider" && webView(entityIconClasses.providerTile),
				className,
			)}
		>
			<Text className={cn(webText(entityIconClasses.monogram), s.mono)}>
				{alt.trim().charAt(0).toUpperCase() || "?"}
			</Text>
		</AppView>
	);
}
