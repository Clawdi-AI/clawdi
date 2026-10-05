import { cn } from "cn";
import type { LucideIcon } from "lucide-react-native";
import { useContext } from "react";
import { useResolveClassNames } from "uniwind";
import { TextClassContext } from "./text";

/**
 * Lucide icon sized and colored by Tailwind classes, inheriting the
 * surrounding text color like `currentColor` on Web. Stroke width matches the
 * Web app-wide `svg.lucide { stroke-width: 1.75 }`.
 */
export function Icon({
	as: Component,
	className,
	strokeWidth = 1.75,
}: {
	as: LucideIcon;
	className?: string;
	strokeWidth?: number;
}) {
	const inherited = useContext(TextClassContext);
	const style = useResolveClassNames(cn("size-4 text-foreground", inherited, className));
	const size = typeof style.width === "number" ? style.width : 16;
	const color = typeof style.color === "string" ? style.color : undefined;
	return <Component size={size} color={color} strokeWidth={strokeWidth} />;
}
