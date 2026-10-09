import { skeletonClassName } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import Animated, { css, cubicBezier, useReducedMotion } from "react-native-reanimated";
import { withUniwind } from "uniwind";
import { resolveWebClasses } from "@/lib/web-classes";

const AnimatedView = withUniwind(Animated.View);

/**
 * Tailwind `animate-pulse`: `pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`.
 *
 * Keep this a CSS animation. Reanimated 4.5 on Android replays every
 * `useAnimatedStyle` view's last props during draw-pass events, including views
 * that were already removed, which floods the UI thread and causes ANRs
 * (software-mansion/react-native-reanimated#10434, fixed in 4.7.1).
 */
const styles = css.create({
	pulse: {
		animationName: css.keyframes({ "50%": { opacity: 0.5 } }),
		animationDuration: "2s",
		animationTimingFunction: cubicBezier(0.4, 0, 0.6, 1),
		animationIterationCount: "infinite",
	},
});

/** apps/web/src/components/ui/skeleton.tsx; a Reanimated CSS animation stands in for `animate-pulse`. */
export function Skeleton({
	className,
	style,
	children,
}: {
	className?: string;
	style?: ViewProps["style"];
	children?: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	return (
		<AnimatedView
			accessibilityElementsHidden
			importantForAccessibility="no"
			className={cn(resolveWebClasses(skeletonClassName).view, className)}
			style={reduceMotion ? style : [style, styles.pulse]}
		>
			{children}
		</AnimatedView>
	);
}
