import type { pairingQr } from "@clawdi/shared/qr";
import Svg, { Path, Rect } from "react-native-svg";

export function QrImage({
	matrix,
	label,
	size = 280,
}: {
	matrix: NonNullable<ReturnType<typeof pairingQr>>;
	label: string;
	size?: number;
}) {
	return (
		<Svg
			width={size}
			height={size}
			viewBox={`0 0 ${matrix.size} ${matrix.size}`}
			accessibilityLabel={label}
			accessibilityRole="image"
		>
			<Rect width={matrix.size} height={matrix.size} fill="white" />
			<Path d={matrix.path} fill="black" />
		</Svg>
	);
}
