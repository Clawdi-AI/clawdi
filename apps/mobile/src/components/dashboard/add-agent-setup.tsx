import {
	desktopHandoffClasses,
	addAgentSetupClasses as styles,
	tabsContentClassName,
} from "@clawdi/shared/ui";
import {
	agentDisplayName,
	agentRegistrationDescription,
	agentSetupPrompt,
	agentSurfaceCopy,
	CLI_STEPS,
	DESKTOP_HANDOFF_COPY,
	HOSTED_PUBLIC_SITE_ORIGIN,
	INSTALLATION_DOCS_URL,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import Laptop from "lucide-react-native/icons/laptop";
import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { NativeSegments } from "@/platform/navigation/segmented-control";
export function AddAgentSetup() {
	const t = useI18n();
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ cloud } = useMobileApi();
	const baseline = useRef<Set<string> | null>(null);
	const [tab, setTab] = useState("prompt");
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
		<WebView recipe={styles.root}>
			{/* Web's Desktop hand-off as a note: a phone can't open Clawdi Desktop's Connect window. */}
			<WebView recipe={desktopHandoffClasses.root}>
				<WebView recipe={desktopHandoffClasses.summary} className="flex-row">
					<IconChip size="sm" tint={desktopHandoffClasses.iconTint}>
						<Icon as={Laptop} />
					</IconChip>
					<WebView recipe={desktopHandoffClasses.body} className="flex-1">
						<WebText recipe={desktopHandoffClasses.title}>{DESKTOP_HANDOFF_COPY.title}</WebText>
						<WebText recipe={desktopHandoffClasses.description}>{t("agents.desktopHint")}</WebText>
					</WebView>
				</WebView>
			</WebView>
			<WebView recipe={styles.manualDivider} className="flex-row">
				<WebView recipe={styles.manualDividerLine} />
				<WebText recipe={styles.manualDivider}>{DESKTOP_HANDOFF_COPY.manualSetup}</WebText>
				<WebView recipe={styles.manualDividerLine} />
			</WebView>
			<NativeSegments
				value={tab}
				onChange={setTab}
				options={[
					{ value: "commands", label: t("agents.runCommands") },
					{ value: "prompt", label: t("agents.askAgent") },
				]}
			/>
			{tab === "commands" ? (
				<WebView recipe={`${tabsContentClassName} ${styles.commands}`}>
					<WebView recipe="">
						<WebText recipe={styles.title}>
							{agentSurfaceCopy.runTheseCommandsInOrderOnTheMachine}
						</WebText>
						<WebText recipe={styles.requirementHint}>
							{agentSurfaceCopy.installationHint}{" "}
							<WebText
								recipe={styles.installationLink}
								accessibilityRole="link"
								onPress={() => {
									// A failed hand-off leaves the setup steps on screen; nothing to recover.
									Linking.openURL(INSTALLATION_DOCS_URL).catch(() => undefined);
								}}
							>
								{agentSurfaceCopy.installationLink}
							</WebText>
							.
						</WebText>
					</WebView>
					<WebView recipe={styles.steps}>
						{CLI_STEPS.map((step, index) => (
							<WebView key={step.title} recipe={styles.step} className="flex-row">
								<WebView recipe={styles.stepNumber}>
									<Text>{index + 1}</Text>
								</WebView>
								<WebView recipe={styles.body}>
									<WebText recipe={styles.title}>{step.title}</WebText>
									<WebView recipe={styles.commandRow} className="flex-row">
										<WebText selectable recipe={styles.command}>
											{step.code}
										</WebText>
									</WebView>
									<WebText recipe={styles.requirementHint}>{step.description}</WebText>
								</WebView>
							</WebView>
						))}
					</WebView>
				</WebView>
			) : (
				<WebView recipe={`${tabsContentClassName} ${styles.promptContent}`}>
					<WebText recipe={styles.title}>{agentSurfaceCopy.askYourAgentToSetUpClawdi}</WebText>
					<WebText recipe={styles.requirementHint}>
						{agentSurfaceCopy.pasteThisPromptIntoClaudeCodeCodexHermesOpenClaw}
					</WebText>
					<WebView recipe={styles.promptPanel}>
						<WebView recipe={styles.promptHeader}>
							<WebText recipe={styles.promptLabel}>{agentSurfaceCopy.setupPrompt}</WebText>
						</WebView>
						<WebText selectable recipe={styles.prompt}>
							{agentSetupPrompt(HOSTED_PUBLIC_SITE_ORIGIN)}
						</WebText>
					</WebView>
				</WebView>
			)}
			<WebView recipe={styles.registration}>
				<WebText recipe={styles.title}>
					{registered.length
						? agentSurfaceCopy.agentRegistered
						: agentSurfaceCopy.watchForYourAgent}
				</WebText>
				{registered.length ? (
					<WebView recipe={styles.registeredAgents}>
						{registered.map((agent) => (
							<WebView key={agent.id} recipe={styles.registeredAgent} className="flex-row">
								<Text>{agentDisplayName(agent)}</Text>
								<Button
									size="sm"
									variant="outline"
									onPress={() =>
										router.push({ pathname: "/agents/[id]", params: { id: agent.id } })
									}
								>
									<Text>{agentSurfaceCopy.openAgent}</Text>
								</Button>
							</WebView>
						))}
						<WebText recipe={styles.registeredDescription}>
							{agentRegistrationDescription(registered)}
						</WebText>
					</WebView>
				) : (
					<WebView recipe={styles.waiting} className="flex-row">
						<WebView recipe={styles.waitingDot} />
						<Text>{t("agents.waitingForConnection")}</Text>
					</WebView>
				)}
			</WebView>
		</WebView>
	);
}
