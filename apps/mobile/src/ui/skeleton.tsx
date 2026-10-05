import { skeletonClassName } from "@clawdi/shared/ui";
import { cn } from "cn";
import { useEffect } from "react";
import type { ViewProps } from "react-native";
import Animated, {
	cancelAnimation,
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";
import { resolveWebClasses } from "./web-classes";

const AnimatedView = withUniwind(Animated.View);

/** apps/web/src/components/ui/skeleton.tsx; Reanimated stands in for `animate-pulse`. */
export function Skeleton({
	className,
	style: layoutStyle,
}: {
	className?: string;
	style?: ViewProps["style"];
}) {
	const opacity = useSharedValue(1);
	useEffect(() => {
		opacity.value = withRepeat(withTiming(0.5, { duration: 1000 }), -1, true);
		return () => cancelAnimation(opacity);
	}, [opacity]);
	const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
	return (
		<AnimatedView
			accessibilityElementsHidden
			importantForAccessibility="no"
			className={cn(resolveWebClasses(skeletonClassName).view, className)}
			style={[layoutStyle, style]}
		/>
	);
}
