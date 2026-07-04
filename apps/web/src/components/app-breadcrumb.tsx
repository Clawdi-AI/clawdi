"use client";

import { Link, useLocation } from "@tanstack/react-router";
import { useBreadcrumbSegmentTitles, useBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { agentSectionLabelFromSegment } from "@/lib/agent-routes";

/**
 * Route-derived header label. Top-level segments map to friendly names
 * (`sessions` → `Sessions`); the last segment of a detail page is replaced
 * by whatever `useSetBreadcrumbTitle()` has registered (session summary,
 * agent machine name, skill name, …) — falling back to a truncated URL
 * segment so loading states still render something legible instead of a
 * full UUID.
 */
const SEGMENT_LABELS: Record<string, string> = {
	projects: "Projects",
	sessions: "Sessions",
	memories: "Memories",
	skills: "Skills",
	vault: "Vaults",
	connectors: "Connectors",
	channels: "Channels",
	deploy: "Deploy an Agent",
	agents: "Agents",
	"ai-providers": "Model Providers",
};

// Looks like a UUID? Truncate it for the loading state — full UUIDs in a
// breadcrumb just push everything off-screen and tell the user nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fallbackLabel(seg: string): string {
	const decoded = decodeURIComponent(seg);
	return UUID_RE.test(decoded) ? `${decoded.slice(0, 8)}…` : decoded;
}

function segmentLabel(
	segments: string[],
	index: number,
	href: string,
	overrideTitle: string | null,
	segmentTitles: Record<string, string>,
): string {
	const seg = segments[index];
	const isLast = index === segments.length - 1;
	if (isLast && overrideTitle) return overrideTitle;
	if (segmentTitles[href]) return segmentTitles[href];
	if (segments[0] === "agents" && index === 1) return "Agent";
	if (segments[0] === "agents" && index === 2) {
		return agentSectionLabelFromSegment(seg) ?? fallbackLabel(seg);
	}
	return SEGMENT_LABELS[seg] ?? fallbackLabel(seg);
}

export function AppBreadcrumb() {
	const pathname = useLocation({ select: (location) => location.pathname });
	const segments = pathname.split("/").filter(Boolean);
	const overrideTitle = useBreadcrumbTitle();
	const segmentTitles = useBreadcrumbSegmentTitles();

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
				{segments
					.map((_seg, i) => i)
					.filter(
						(i) =>
							!(
								segments[0] === "agents" &&
								segments[2] === "skills" &&
								segments.length > 4 &&
								i > 2 &&
								i < segments.length - 1
							),
					)
					.map((i) => {
						const href = `/${segments.slice(0, i + 1).join("/")}`;
						const isLast = i === segments.length - 1;
						const label = segmentLabel(segments, i, href, overrideTitle, segmentTitles);
						return (
							<span key={href} className="contents">
								<BreadcrumbItem>
									{isLast ? (
										<BreadcrumbPage className="max-w-[calc(100vw-6rem)] truncate sm:max-w-[420px]">
											{label}
										</BreadcrumbPage>
									) : (
										// render lets us pass our own router-aware link while
										// preserving shadcn's breadcrumb anchor semantics.
										<BreadcrumbLink render={<Link to={href} />}>{label}</BreadcrumbLink>
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
