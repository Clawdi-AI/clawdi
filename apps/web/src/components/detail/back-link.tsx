"use client";

import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Back affordance for detail pages. Content states keep the default
 * (mobile-only — desktop has the header breadcrumb); error, not-found,
 * and loading states pass `mobileOnly={false}` because a dead-end page
 * needs a visible exit on every viewport.
 */
export function DetailBackLink({
	href,
	label,
	mobileOnly = true,
}: {
	href: string;
	label: string;
	mobileOnly?: boolean;
}) {
	return (
		<Button
			render={<Link to={href} />}
			nativeButton={false}
			variant="ghost"
			size="sm"
			className={cn("w-fit", mobileOnly && "sm:hidden")}
		>
			<ArrowLeft className="size-4" />
			Back to {label}
		</Button>
	);
}
