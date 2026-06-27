import { SkillDetailContent } from "@/app/(dashboard)/skills/[key]/page";
import { decodeResourceRouteParam } from "@/lib/project-resource-model";

type AgentSkillDetailPageProps = {
	params: Promise<{ id: string; key: string[] }>;
};

export default async function AgentSkillDetailPage({ params }: AgentSkillDetailPageProps) {
	const { id, key } = await params;
	const skillKey = key.map(decodeResourceRouteParam).join("/");
	return <SkillDetailContent agentId={id} skillKey={skillKey} />;
}
