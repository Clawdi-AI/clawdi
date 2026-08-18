import type { BreadcrumbSegmentTitles } from "@/components/breadcrumb-title";
import {
	type AgentRouteSearch,
	agentProjectDetailHref,
	agentProjectResourceHref,
	agentSectionHref,
	agentSectionLabel,
	parseAgentPathname,
} from "@/lib/agent-routes";

export type AppBreadcrumbTrailItem = {
	key: string;
	label: string | null;
	href?: string;
};

type BreadcrumbTrailInput = {
	pathname: string;
	search: AgentRouteSearch;
	overrideTitle: string | null;
	segmentTitles: BreadcrumbSegmentTitles;
};

const SEGMENT_LABELS: Record<string, string> = {
	projects: "Projects",
	sessions: "Sessions",
	memories: "Memories",
	skills: "Skills",
	vault: "Vaults",
	vaults: "Vaults",
	connectors: "Connectors",
	channels: "Channels",
	deploy: "Deploy an Agent",
	agents: "Agents",
	"ai-providers": "AI Providers",
};

const DETAIL_COLLECTION_SEGMENTS = new Set([
	"projects",
	"sessions",
	"memories",
	"skills",
	"vault",
	"vaults",
	"connectors",
	"channels",
]);

export function buildAppBreadcrumbTrail({
	pathname,
	search,
	overrideTitle,
	segmentTitles,
}: BreadcrumbTrailInput): AppBreadcrumbTrailItem[] {
	const agentRoute = parseAgentPathname(pathname);
	if (agentRoute) {
		return buildAgentBreadcrumbTrail(agentRoute, search, overrideTitle, segmentTitles);
	}
	return buildGenericBreadcrumbTrail(pathname, overrideTitle, segmentTitles);
}

function buildAgentBreadcrumbTrail(
	route: NonNullable<ReturnType<typeof parseAgentPathname>>,
	search: AgentRouteSearch,
	overrideTitle: string | null,
	segmentTitles: BreadcrumbSegmentTitles,
): AppBreadcrumbTrailItem[] {
	const agentHref = agentSectionHref(route.agentId, "overview");
	const agentTitle = segmentTitle(segmentTitles, agentHref);
	const trail: AppBreadcrumbTrailItem[] = [{ key: "agent", label: agentTitle, href: agentHref }];

	if (route.section === "overview") {
		return finishTrail(trail, overrideTitle ?? agentTitle);
	}

	if (route.section === "projects") {
		if (!route.projectId) {
			return finishTrail(trail, agentSectionLabel("projects"));
		}
		const context = projectContext(route.agentId, route.projectId, segmentTitles);
		appendProjectContext(trail, route.agentId, context);
		if (route.projectResource) {
			return finishTrail(trail, overrideTitle ?? agentSectionLabel(route.projectResource));
		}
		if (context.kind !== "project") {
			return finishTrail(trail, agentTitle);
		}
		return finishTrail(trail, overrideTitle ?? context.label);
	}

	if (route.section === "skills" || route.section === "vaults") {
		const projectId = typeof search.project === "string" ? search.project.trim() : "";
		if (projectId) {
			const context = projectContext(route.agentId, projectId, segmentTitles);
			appendProjectContext(trail, route.agentId, context);
			const resourceHref = agentProjectResourceHref(route.agentId, projectId, route.section);
			trail.push({
				key: route.section,
				label: agentSectionLabel(route.section),
				href: resourceHref,
			});
		} else {
			trail.push({
				key: "projects",
				label: agentSectionLabel("projects"),
				href: agentSectionHref(route.agentId, "projects"),
			});
		}
		const hasDetail =
			route.section === "skills" ? Boolean(route.skillKey) : Boolean(route.vaultSlug);
		return hasDetail
			? finishTrail(trail, overrideTitle)
			: finishTrail(trail, agentSectionLabel(route.section));
	}

	const sectionLabel = agentSectionLabel(route.section);
	const sectionHref = agentSectionHref(route.agentId, route.section);
	const detailTitle =
		route.sessionId || route.memoryId || route.connectorName ? overrideTitle : null;
	if (route.sessionId || route.memoryId || route.connectorName) {
		trail.push({ key: route.section, label: sectionLabel, href: sectionHref });
		return finishTrail(trail, detailTitle);
	}
	return finishTrail(trail, overrideTitle ?? sectionLabel);
}

function projectContext(
	agentId: string,
	projectId: string,
	segmentTitles: BreadcrumbSegmentTitles,
) {
	const href = agentProjectDetailHref(agentId, projectId);
	const label = segmentTitle(segmentTitles, href);
	const registeredContext = segmentContext(segmentTitles, href);
	return {
		projectId,
		href,
		label,
		kind: !label ? null : registeredContext === "workspace" ? "workspace" : "project",
	};
}

function appendProjectContext(
	trail: AppBreadcrumbTrailItem[],
	agentId: string,
	context: ReturnType<typeof projectContext>,
) {
	if (context.kind !== "project") return;
	trail.push({
		key: "projects",
		label: "Projects",
		href: agentSectionHref(agentId, "projects"),
	});
	trail.push({
		key: `project:${context.projectId}`,
		label: context.label,
		href: context.href,
	});
}

function buildGenericBreadcrumbTrail(
	pathname: string,
	overrideTitle: string | null,
	segmentTitles: BreadcrumbSegmentTitles,
): AppBreadcrumbTrailItem[] {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length === 0) return [{ key: "overview", label: "Overview" }];
	return segments.map((segment, index) => {
		const href = `/${segments.slice(0, index + 1).join("/")}`;
		const isLast = index === segments.length - 1;
		const previousSegment = segments[index - 1]?.toLowerCase();
		const label =
			isLast && overrideTitle
				? overrideTitle
				: (segmentTitle(segmentTitles, href) ??
					(isLast && previousSegment && DETAIL_COLLECTION_SEGMENTS.has(previousSegment)
						? null
						: (SEGMENT_LABELS[segment.toLowerCase()] ?? safeDecodeURIComponent(segment))));
		return {
			key: href,
			label,
			...(isLast ? {} : { href }),
		};
	});
}

function finishTrail(
	trail: AppBreadcrumbTrailItem[],
	label: string | null,
): AppBreadcrumbTrailItem[] {
	const last = trail.at(-1);
	if (last?.label === label) {
		trail[trail.length - 1] = { ...last, href: undefined };
		return trail;
	}
	trail.push({ key: `current:${trail.length}`, label });
	return trail;
}

function segmentTitle(segmentTitles: BreadcrumbSegmentTitles, href: string): string | null {
	const [path] = href.split("?");
	return segmentTitles[path.replace(/\/+$/, "") || "/"]?.title.trim() || null;
}

function segmentContext(segmentTitles: BreadcrumbSegmentTitles, href: string) {
	const [path] = href.split("?");
	return segmentTitles[path.replace(/\/+$/, "") || "/"]?.context;
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
