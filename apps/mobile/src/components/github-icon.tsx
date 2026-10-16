import { GITHUB_MARK_PATH } from "@clawdi/shared/consts";
import type { LucideProps } from "lucide-react-native";
import Svg, { Path } from "react-native-svg";

/** Web's Help-menu GitHub mark; filled, so it ignores the Lucide stroke props `Icon` passes. */
export function GitHubIcon({ size = 16, color }: Pick<LucideProps, "size" | "color">) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill={color} accessibilityElementsHidden>
			<Path d={GITHUB_MARK_PATH} />
		</Svg>
	);
}
