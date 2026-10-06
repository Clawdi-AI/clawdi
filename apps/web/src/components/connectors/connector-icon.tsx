"use client";
import { CONNECTOR_ICON_SIZES, connectorIconClasses } from "@clawdi/shared/ui";

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";

export function ConnectorIcon({
	logo,
	name,
	size = "md",
}: {
	logo?: string;
	name: string;
	size?: keyof typeof CONNECTOR_ICON_SIZES;
}) {
	const [imageState, setImageState] = useState<{
		src: string;
		status: "loaded" | "error";
	} | null>(null);
	const loaded = imageState?.status === "loaded" && imageState.src === logo;
	const failed = imageState?.status === "error" && imageState.src === logo;
	const imageRef = useCallback(
		(image: HTMLImageElement | null) => {
			if (logo && image?.complete) {
				setImageState({ src: logo, status: image.naturalWidth > 0 ? "loaded" : "error" });
			}
		},
		[logo],
	);
	const s = CONNECTOR_ICON_SIZES[size];
	const letter =
		name
			.replace(/^[_\-\s]+/, "")
			.charAt(0)
			.toUpperCase() || "?";

	return (
		<div
			className={cn(
				connectorIconClasses.root,
				loaded ? connectorIconClasses.loaded : connectorIconClasses.placeholder,
				s.box,
				s.radius,
			)}
		>
			<span className={cn(connectorIconClasses.letter, s.text, loaded && "invisible")}>
				{letter}
			</span>
			{logo && !failed ? (
				<img
					key={logo}
					ref={imageRef}
					src={logo}
					alt=""
					loading="lazy"
					decoding="async"
					className={cn(connectorIconClasses.image, s.pad, loaded ? "opacity-100" : "opacity-0")}
					onLoad={() => setImageState({ src: logo, status: "loaded" })}
					onError={() => setImageState({ src: logo, status: "error" })}
				/>
			) : null}
		</div>
	);
}
