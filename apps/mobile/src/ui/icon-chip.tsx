import {
	ICON_CHIP_SIZE_CLASS,
	type IconChipSize,
	iconChipClasses as styles,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { type ReactNode, useContext } from "react";
import { useCSSVariable } from "uniwind";
import { TextClassContext, TextColorContext } from "./text";
import { WebContent, WebView } from "./web-layout";

export type { IconChipSize } from "@clawdi/shared/ui";
/** The direct-SVG selector supplies glyph size to RN's explicit Icon context. */
export function IconChip({
	size = "md",
	tint = styles.defaultTint,
	className,
	children,
	"aria-hidden": hidden = true,
}: {
	size?: IconChipSize;
	tint?: string;
	className?: string;
	children: ReactNode;
	"aria-hidden"?: boolean;
}) {
	const inherited = useContext(TextClassContext);
	const backgroundToken = /\bbg-(identity-\d-bg)\b/.exec(tint)?.[1];
	const foregroundToken = /\btext-(identity-\d-fg)\b/.exec(tint)?.[1];
	const [background, foreground] = useCSSVariable([
		`--color-${backgroundToken ?? "muted"}`,
		`--color-${foregroundToken ?? "foreground"}`,
	]);
	const inheritedColor = useContext(TextColorContext);
	const color = foregroundToken && typeof foreground === "string" ? foreground : inheritedColor;
	const glyph = /\[&>svg\]:(size-[\d.]+)/.exec(ICON_CHIP_SIZE_CLASS[size])?.[1];
	const textual = typeof children === "string" || typeof children === "number";
	return (
		<TextColorContext.Provider value={color}>
			<TextClassContext.Provider value={cn(inherited, !textual && glyph)}>
				<WebView
					recipe={cn(styles.root, ICON_CHIP_SIZE_CLASS[size], tint)}
					accessibilityElementsHidden={hidden}
					importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
					className={className}
					style={
						backgroundToken && typeof background === "string"
							? { backgroundColor: background }
							: undefined
					}
				>
					{textual ? <WebContent recipe={styles.root}>{children}</WebContent> : children}
				</WebView>
			</TextClassContext.Provider>
		</TextColorContext.Provider>
	);
}
