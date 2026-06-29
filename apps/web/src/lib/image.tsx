import type { ImgHTMLAttributes } from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> & {
	src: string;
	alt: string;
	width?: number | `${number}`;
	height?: number | `${number}`;
	unoptimized?: boolean;
	priority?: boolean;
	fill?: boolean;
};

export function Image({
	alt,
	fill,
	priority: _priority,
	unoptimized: _unoptimized,
	style,
	...props
}: ImageProps) {
	return (
		<img
			{...props}
			alt={alt}
			style={{
				...(fill
					? {
							position: "absolute",
							inset: 0,
							width: "100%",
							height: "100%",
						}
					: null),
				...style,
			}}
		/>
	);
}

export default Image;
