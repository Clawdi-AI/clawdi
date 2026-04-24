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
 * Route-derived header label. Mirrors shadcn dashboard-01's single `<h1>` —
 * top-level pages show just the page name, detail pages (e.g. `/sessions/<id>`)
 * add the parent section as a breadcrumb link so users can get back.
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
