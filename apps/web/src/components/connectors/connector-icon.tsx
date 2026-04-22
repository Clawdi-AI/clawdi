"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const SIZES = {
	sm: { box: "size-9", img: "size-5", text: "text-sm", radius: "rounded-lg" },
	md: { box: "size-11", img: "size-6", text: "text-xl", radius: "rounded-xl" },
	lg: { box: "size-14", img: "size-8", text: "text-3xl", radius: "rounded-2xl" },
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
	const [imgError, setImgError] = useState(false);
	const s = SIZES[size];
	const letter =
		name
			.replace(/^[_\-\s]+/, "")
			.charAt(0)
			.toUpperCase() || "?";

	return (
		<div className={cn("flex shrink-0 items-center justify-center bg-muted", s.box, s.radius)}>
			{logo && !imgError ? (
				<img src={logo} alt="" className={cn(s.img, "rounded")} onError={() => setImgError(true)} />
			) : (
				<span className={cn("font-semibold text-muted-foreground", s.text)}>{letter}</span>
			)}
		</div>
	);
}
