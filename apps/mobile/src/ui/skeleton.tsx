import { cn } from "cn";
import { useEffect } from "react";
import Animated, {
	cancelAnimation,
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

const AnimatedView = withUniwind(Animated.View);

/** Mirrors apps/web/src/components/ui/skeleton.tsx (`animate-pulse`). */
export function Skeleton({ className }: { className?: string }) {
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
			className={cn("rounded-md bg-muted", className)}
			style={style}
		/>
	);
}
