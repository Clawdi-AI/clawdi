import { redirect } from "next/navigation";
import { AgentDetailClient } from "@/app/(dashboard)/agents/[id]/agent-detail-client";
import { agentSectionHref, hasAgentTabQuery } from "@/lib/agent-routes";

type AgentPageProps = {
	params: Promise<{ id: string }>;
	searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AgentDetailPage({ params, searchParams }: AgentPageProps) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	if (hasAgentTabQuery(query)) {
		redirect(agentSectionHref(id, "overview", query));
	}

	return <AgentDetailClient environmentId={id} section="overview" />;
}
