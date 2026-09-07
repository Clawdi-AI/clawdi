"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";

const SIZES = {
	sm: { box: "size-6", pad: "p-0.5", text: "text-xs", radius: "rounded-md" },
	md: { box: "size-10", pad: "p-1.5", text: "text-base", radius: "rounded-lg" },
	lg: { box: "size-14", pad: "p-2", text: "text-2xl", radius: "rounded-xl" },
} as const;

export function ConnectorIcon({
	logo,
	name,
	size = "md",
}: {
	logo?: string;
	name: string;
	size?: keyof typeof SIZES;
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
	const s = SIZES[size];
	const letter =
		name
			.replace(/^[_\-\s]+/, "")
			.charAt(0)
			.toUpperCase() || "?";

	return (
		<div
			className={cn(
				"relative flex shrink-0 items-center justify-center overflow-hidden border",
				loaded ? "bg-background" : "bg-muted",
				s.box,
				s.radius,
			)}
		>
			<span className={cn("font-semibold text-muted-foreground", s.text, loaded && "invisible")}>
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
					className={cn(
						"absolute inset-0 h-full w-full object-contain transition-opacity",
						s.pad,
						loaded ? "opacity-100" : "opacity-0",
					)}
					onLoad={() => setImageState({ src: logo, status: "loaded" })}
					onError={() => setImageState({ src: logo, status: "error" })}
				/>
			) : null}
		</div>
	);
}
