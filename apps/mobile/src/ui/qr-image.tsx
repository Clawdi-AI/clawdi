import type { pairingQr } from "@clawdi/shared/qr";
import Svg, { Path, Rect } from "react-native-svg";

export function QrImage({
	matrix,
	label,
}: {
	matrix: NonNullable<ReturnType<typeof pairingQr>>;
	label: string;
}) {
	return (
		<Svg
			width={280}
			height={280}
			viewBox={`0 0 ${matrix.size} ${matrix.size}`}
			accessibilityLabel={label}
			accessibilityRole="image"
		>
			<Rect width={matrix.size} height={matrix.size} fill="white" />
			<Path d={matrix.path} fill="black" />
		</Svg>
	);
}
