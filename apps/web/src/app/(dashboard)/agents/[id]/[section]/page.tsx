import { notFound, redirect } from "next/navigation";
import { AgentDetailClient } from "@/app/(dashboard)/agents/[id]/agent-detail-client";
import {
	agentSectionHref,
	agentSectionSegment,
	hasAgentTabQuery,
	parseAgentSectionSegment,
} from "@/lib/agent-routes";

type AgentSectionPageProps = {
	params: Promise<{ id: string; section: string }>;
	searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export default async function AgentSectionPage({ params, searchParams }: AgentSectionPageProps) {
	const [{ id, section: rawSection }, query] = await Promise.all([params, searchParams]);
	const decodedSection = safeDecodeURIComponent(rawSection);
	const section = parseAgentSectionSegment(decodedSection);
	if (!section || section === "overview") notFound();

	const canonicalSegment = agentSectionSegment(section);

	if (decodedSection !== canonicalSegment || hasAgentTabQuery(query)) {
		redirect(agentSectionHref(id, section, query));
	}

	return <AgentDetailClient environmentId={id} section={section} />;
}
