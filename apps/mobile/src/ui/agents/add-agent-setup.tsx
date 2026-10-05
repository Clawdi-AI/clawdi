import { addAgentSetupClasses as styles } from "@clawdi/shared/ui";
import {
	agentDisplayName,
	agentRegistrationDescription,
	agentSurfaceCopy,
	CLI_STEPS,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { Button } from "../button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs";
import { Text } from "../text";
import { WebText, WebView, webView } from "../web-layout";
export function AddAgentSetup() {
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ cloud } = useMobileApi();
	const baseline = useRef<Set<string> | null>(null);
	const agents = useQuery({
		queryKey: accountQueryKey(scope, "add-agent-registration"),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) => read((lease) => cloud.listAgents(undefined, lease), signal),
		refetchInterval: (query) =>
			query.state.data?.some((agent) => baseline.current && !baseline.current.has(agent.id))
				? false
				: 5000,
		refetchIntervalInBackground: false,
	});
	useEffect(() => {
		if (agents.data && !baseline.current)
			baseline.current = new Set(agents.data.map((agent) => agent.id));
	}, [agents.data]);
	const registered = (agents.data ?? []).filter(
		(agent) => baseline.current && !baseline.current.has(agent.id),
	);
	return (
		<WebView recipe={styles.spaceY}>
			<Tabs defaultValue="commands">
				<TabsList variant="default">
					<TabsTrigger value="commands">Run commands</TabsTrigger>
					<TabsTrigger value="prompt">Ask your agent</TabsTrigger>
				</TabsList>
				<TabsContent value="commands" className={webView(styles.mtSpaceY)}>
					<WebView recipe="">
						<WebText recipe={styles.textSmFontMedium}>
							Run these commands in order on the machine
						</WebText>
						<WebText recipe={styles.mtTextXsText}>{agentSurfaceCopy.nodeJs24IsRequired}</WebText>
						<WebText recipe={styles.mtTextXsText2}>
							Prefer Bun? Use: bun add -g clawdi@latest
						</WebText>
					</WebView>
					<WebView recipe={styles.spaceY2}>
						{CLI_STEPS.map((step, index) => (
							<WebView key={step.title} recipe={styles.flexGap} className="flex-row">
								<WebView recipe={styles.flexSizeShrinkItems2}>
									<Text>{index + 1}</Text>
								</WebView>
								<WebView recipe={styles.minWFlex}>
									<WebText recipe={styles.textSmFontMedium}>{step.title}</WebText>
									<WebView recipe={styles.mtFlexItemsCenter2}>
										<WebText selectable recipe={styles.minWFlexOverflow}>
											{step.code}
										</WebText>
									</WebView>
									<WebText recipe={styles.mtTextXsText}>{step.description}</WebText>
								</WebView>
							</WebView>
						))}
					</WebView>
				</TabsContent>
				<TabsContent value="prompt" className={webView(styles.mtSpaceY2)}>
					<WebText recipe={styles.textSmFontMedium}>
						{agentSurfaceCopy.askYourAgentToSetUpClawdi}
					</WebText>
					<WebText recipe={styles.mtTextXsText}>
						Paste this prompt into Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode on the
						machine.
					</WebText>
					<WebView recipe={styles.roundedLgBorderBg}>
						<WebView recipe={styles.flexItemsCenterJustify}>
							<WebText recipe={styles.textXsUppercaseTracking}>
								{agentSurfaceCopy.setupPrompt}
							</WebText>
						</WebView>
						<WebText selectable recipe={styles.whitespacePreWrapP}>
							Set up Clawdi on this machine. Fetch https://cloud.clawdi.ai/skill.md, and follow the
							skills to set it up. Finally, confirm the installation with `clawdi doctor`.
						</WebText>
					</WebView>
				</TabsContent>
			</Tabs>
			<WebView recipe={styles.borderTPt}>
				<WebText recipe={styles.textSmFontMedium}>
					{registered.length ? "Agent registered" : "Watch for your agent"}
				</WebText>
				{registered.length ? (
					<WebView recipe={styles.mtSpaceYRounded}>
						{registered.map((agent) => (
							<WebView key={agent.id} recipe={styles.flexItemsCenterJustify2} className="flex-row">
								<Text>{agentDisplayName(agent)}</Text>
								<Button
									size="sm"
									variant="outline"
									onPress={() =>
										router.push({ pathname: "/agents/[agentId]", params: { agentId: agent.id } })
									}
								>
									<Text>Open agent</Text>
								</Button>
							</WebView>
						))}
						<WebText recipe={styles.textXsTextSuccess}>
							{agentRegistrationDescription(registered)}
						</WebText>
					</WebView>
				) : (
					<WebView recipe={styles.mtFlexItemsCenter}>
						<Text>Waiting for your agent to connect…</Text>
					</WebView>
				)}
			</WebView>
		</WebView>
	);
}
