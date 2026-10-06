import { workspaceSkillsPanelClasses as panel } from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	workspaceSkillInstallCommand,
	workspaceSkillRemoveCommand,
} from "@clawdi/shared/view";
import { useLocalSearchParams, useSegments } from "expo-router";
import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { routeParam } from "@/lib/route-params";
export default function AgentSkillCommandPage() {
	const params = useLocalSearchParams<{ id?: string | string[]; key?: string | string[] }>();
	const id = routeParam(params.id),
		key = routeParam(params.key);
	const remove = useSegments().at(-1) === "uninstall";
	const agent = useCloudAgent(id);
	const [repo, setRepo] = useState("");
	const command = agent.data
		? remove
			? key
				? workspaceSkillRemoveCommand(key, agent.data.agent_type)
				: ""
			: repo.trim()
				? workspaceSkillInstallCommand(repo, agent.data.agent_type)
				: ""
		: "";
	return (
		<SheetPage
			title={remove ? agentSurfaceCopy.uninstallSkill : agentSurfaceCopy.installSkill}
			description={
				remove
					? agentSurfaceCopy.runThisCommandOnTheAgentMachineTheSkill
					: "Enter a GitHub skill path, then run the generated command on the agent machine."
			}
			fallback={id ? `/agents/${id}/skills` : "/agents"}
		>
			<WebView recipe={panel.form}>
				{!remove ? (
					<WebView recipe={panel.field}>
						<Label>{agentSurfaceCopy.gitHubSkillRepository}</Label>
						<Input
							value={repo}
							onChangeText={setRepo}
							maxLength={2048}
							placeholder={agentSurfaceCopy.ownerRepoOrOwnerRepoPathTo}
							autoCapitalize="none"
							autoCorrect={false}
						/>
					</WebView>
				) : null}
				{command ? (
					<WebView recipe={panel.commandRow} className="flex-row">
						<WebText selectable recipe={panel.command}>
							{command}
						</WebText>
					</WebView>
				) : null}
			</WebView>
		</SheetPage>
	);
}
