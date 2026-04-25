"use client";

import { usePathname } from "next/navigation";
import { useBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Route-derived header label. Top-level segments map to friendly names
 * (`sessions` → `Sessions`); the last segment of a detail page is replaced
 * by whatever `useSetBreadcrumbTitle()` has registered (session summary,
 * agent machine name, skill name, …) — falling back to a truncated URL
 * segment so loading states still render something legible instead of a
 * full UUID.
 */
const SEGMENT_LABELS: Record<string, string> = {
	sessions: "Sessions",
	memories: "Memories",
	skills: "Skills",
	vault: "Vault",
	connectors: "Connectors",
	agents: "Agents",
};

// Looks like a UUID? Truncate it for the loading state — full UUIDs in a
// breadcrumb just push everything off-screen and tell the user nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fallbackLabel(seg: string): string {
	const decoded = decodeURIComponent(seg);
	return UUID_RE.test(decoded) ? `${decoded.slice(0, 8)}…` : decoded;
}

export function AppBreadcrumb() {
	const pathname = usePathname();
	const segments = pathname.split("/").filter(Boolean);
	const overrideTitle = useBreadcrumbTitle();

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
					const isLast = i === segments.length - 1;
					const label =
						isLast && overrideTitle ? overrideTitle : (SEGMENT_LABELS[seg] ?? fallbackLabel(seg));
					return (
						<span key={href} className="contents">
							<BreadcrumbItem>
								{isLast ? (
									<BreadcrumbPage className="max-w-[420px] truncate">{label}</BreadcrumbPage>
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
