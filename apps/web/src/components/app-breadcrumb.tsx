"use client";

import { usePathname } from "next/navigation";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Derive breadcrumb from the current route. Keeps the header signal automatic —
 * pages never have to remember to set it. For a route `/connectors/github`
 * this renders: `Dashboard › Connectors › github`.
 */
const SEGMENT_LABELS: Record<string, string> = {
	sessions: "Sessions",
	memories: "Memories",
	skills: "Skills",
	vault: "Vault",
	connectors: "Connectors",
};

export function AppBreadcrumb() {
	const pathname = usePathname();
	const segments = pathname.split("/").filter(Boolean);

	if (segments.length === 0) {
		return (
			<Breadcrumb>
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbPage>Overview</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>
		);
	}

	return (
		<Breadcrumb>
			<BreadcrumbList>
				<BreadcrumbItem className="hidden md:block">
					<BreadcrumbLink href="/">Dashboard</BreadcrumbLink>
				</BreadcrumbItem>
				<BreadcrumbSeparator className="hidden md:block" />
				{segments.map((seg, i) => {
					const href = `/${segments.slice(0, i + 1).join("/")}`;
					const label = SEGMENT_LABELS[seg] ?? decodeURIComponent(seg);
					const isLast = i === segments.length - 1;
					return (
						<span key={href} className="contents">
							<BreadcrumbItem>
								{isLast ? (
									<BreadcrumbPage className="truncate max-w-[240px]">{label}</BreadcrumbPage>
								) : (
									<BreadcrumbLink href={href}>{label}</BreadcrumbLink>
								)}
							</BreadcrumbItem>
							{!isLast ? <BreadcrumbSeparator /> : null}
						</span>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
