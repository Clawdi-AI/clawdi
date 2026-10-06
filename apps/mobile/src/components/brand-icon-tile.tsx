import { brandIconTileClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { useResolveClassNames } from "uniwind";
import { WebView, webText } from "@/components/ui/web-layout";

export type BrandIconComponent = ComponentType<{ size?: number | string; className?: string }>;
/** Bundled, unchanged SVG paths from the exact LobeHub components used on Web. */
export function createBrandIcon(xml: string): BrandIconComponent {
	return function BrandMark({ size = "100%", className }) {
		const style = useResolveClassNames(cn(webText(styles.root), className));
		return (
			<SvgXml
				xml={xml}
				width={size}
				height={size}
				color={typeof style.color === "string" ? style.color : undefined}
			/>
		);
	};
}
export function BrandIconTile({
	icon: Mark,
	label,
	boxClassName,
	iconClassName,
	iconScale = 0.84,
	className,
}: {
	icon: BrandIconComponent;
	label: string;
	boxClassName: string;
	iconClassName?: string;
	iconScale?: number;
	className?: string;
}) {
	return (
		<WebView
			accessibilityRole="image"
			accessibilityLabel={label}
			recipe={cn(boxClassName, styles.root, className)}
		>
			<Mark size={`${iconScale * 100}%`} className={iconClassName} />
		</WebView>
	);
}
