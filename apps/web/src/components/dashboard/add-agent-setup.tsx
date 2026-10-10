"use client";

import { addAgentSetupClasses } from "@clawdi/shared/ui";
import {
	agentRegistrationDescription,
	agentSurfaceCopy,
	CLI_STEPS,
	DESKTOP_HANDOFF_COPY,
	INSTALLATION_DOCS_URL,
} from "@clawdi/shared/view";
import { Link } from "@tanstack/react-router";
import { Bot, Check, Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentLabel, AgentSourceBadgeForEnvironment } from "@/components/dashboard/agent-label";
import { DesktopConnectHandoff } from "@/components/dashboard/desktop-connect-handoff";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { agentSetupPrompt } from "@/lib/agent-setup-prompt";
import { useOpenApi } from "@/lib/api";
import { useDesktopShell } from "@/lib/desktop-shell";
import { publicSiteOrigin } from "@/lib/public-site";
import { cn } from "@/lib/utils";

// Fallback origin used during SSR and on the first client render before the
// useEffect fires, so server and client markup match. The real origin is
// swapped in post-mount.
const DEFAULT_ORIGIN = "https://cloud.clawdi.ai";

function useOrigin() {
	const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);
	return origin;
}

// The CLI onboarding contract test reads the install steps from this module.
export { CLI_STEPS };

export function CopyButton({
	text,
	label,
	className,
}: {
	text: string;
	label: string;
	className?: string;
}) {
	const { copied, copy } = useCopyToClipboard(
		{
			success: false,
			error: "Couldn't copy. Select the prompt and copy it manually.",
		},
		2000,
	);
	return (
		<>
			<span aria-live="polite" className="sr-only">
				{copied ? "Copied" : ""}
			</span>
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={() => copy(text)}
				className={cn("text-muted-foreground hover:text-foreground", className)}
				aria-label={label}
			>
				{copied ? (
					<Check className={addAgentSetupClasses.actionIcon} />
				) : (
					<Copy className={addAgentSetupClasses.actionIcon} />
				)}
			</Button>
		</>
	);
}

/**
 * Shared setup body for every `AddAgentDialog`. Clawdi Desktop is the primary
 * path; commands and the agent hand-off prompt are peer manual fallbacks. While
 * the dialog is open, the setup also watches for newly registered agents and
 * surfaces an explicit success state.
 */
export function AddAgentSetup() {
	const api = useOpenApi();
	const desktop = useDesktopShell();
	const origin = useOrigin();
	const prompt = agentSetupPrompt(publicSiteOrigin(origin));
	const baseline = useRef<Set<string> | null>(null);

	// Live success detection: snapshot the env ids on first load, then poll
	// while mounted until a new Agent appears. Anything new is "your agent
	// just connected"; once that terminal state is reached, polling stops.
	const envs = api.useQuery(
		"get",
		"/v1/agents",
		{},
		{
			refetchInterval: (query) => {
				const current = query.state.data;
				if (!current || !baseline.current) return 5_000;
				return current.some((agent) => !baseline.current?.has(agent.id)) ? false : 5_000;
			},
			refetchIntervalInBackground: false,
		},
	);
	useEffect(() => {
		if (envs.data && baseline.current === null) {
			baseline.current = new Set(envs.data.map((e) => e.id));
		}
	}, [envs.data]);
	const newAgents = (envs.data ?? []).filter(
		(e) => baseline.current !== null && !baseline.current.has(e.id),
	);

	return (
		<div className={addAgentSetupClasses.root}>
			{/* Inside Clawdi Desktop, connect actions open its Connect window instead. */}
			{desktop.inDesktop ? null : (
				<>
					<DesktopConnectHandoff />
					<div className={addAgentSetupClasses.manualDivider}>
						<span className={addAgentSetupClasses.manualDividerLine} />
						{DESKTOP_HANDOFF_COPY.manualSetup}
						<span className={addAgentSetupClasses.manualDividerLine} />
					</div>
				</>
			)}
			<Tabs defaultValue="prompt">
				<TabsList className={addAgentSetupClasses.tabsList}>
					<TabsTrigger value="commands">
						<Terminal data-icon="inline-start" /> Run commands
					</TabsTrigger>
					<TabsTrigger value="prompt">
						<Bot data-icon="inline-start" /> Ask your agent
					</TabsTrigger>
				</TabsList>
				<TabsContent value="commands" className={addAgentSetupClasses.commands}>
					<div>
						<p className={addAgentSetupClasses.title}>
							{agentSurfaceCopy.runTheseCommandsInOrderOnTheMachine}
						</p>
						<p className={addAgentSetupClasses.requirementHint}>
							{agentSurfaceCopy.installationHint}{" "}
							<a href={INSTALLATION_DOCS_URL} className={addAgentSetupClasses.installationLink}>
								{agentSurfaceCopy.installationLink}
							</a>
							.
						</p>
					</div>
					<CommandSteps steps={CLI_STEPS} numbered />
				</TabsContent>
				<TabsContent value="prompt" className={addAgentSetupClasses.promptContent}>
					<div>
						<p className={addAgentSetupClasses.title}>
							{agentSurfaceCopy.askYourAgentToSetUpClawdi}
						</p>
						<p className={addAgentSetupClasses.requirementHint}>
							{agentSurfaceCopy.pasteThisPromptIntoClaudeCodeCodexHermesOpenClaw}
						</p>
					</div>
					<div className={addAgentSetupClasses.promptPanel}>
						<div className={addAgentSetupClasses.promptHeader}>
							<span className={addAgentSetupClasses.promptLabel}>
								{agentSurfaceCopy.setupPrompt}
							</span>
							<CopyButton text={prompt} label="Copy setup prompt" />
						</div>
						<pre className={addAgentSetupClasses.prompt}>{prompt}</pre>
					</div>
				</TabsContent>
			</Tabs>

			<div className={addAgentSetupClasses.registration}>
				<div className={addAgentSetupClasses.registrationHeading}>
					{newAgents.length > 0 ? (
						<span className={addAgentSetupClasses.registeredIcon}>
							<Check className={addAgentSetupClasses.actionIcon} />
						</span>
					) : null}
					<span className={addAgentSetupClasses.title}>
						{newAgents.length > 0
							? agentSurfaceCopy.agentRegistered
							: agentSurfaceCopy.watchForYourAgent}
					</span>
				</div>
				{newAgents.length > 0 ? (
					<div className={addAgentSetupClasses.registeredAgents}>
						{newAgents.map((env) => (
							<div key={env.id} className={addAgentSetupClasses.registeredAgent}>
								<AgentLabel
									machineName={env.machine_name}
									displayName={env.display_name}
									defaultName={env.default_name}
									type={env.agent_type}
									avatarUrl={env.avatar_url}
									size="sm"
									titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
									className={addAgentSetupClasses.body}
								/>
								<Button
									render={<Link to="/agents/$id" params={{ id: env.id }} />}
									nativeButton={false}
									size="sm"
									variant="outline"
								>
									{agentSurfaceCopy.openAgent}
								</Button>
							</div>
						))}
						<p className={addAgentSetupClasses.registeredDescription}>
							{agentRegistrationDescription(newAgents)}
						</p>
					</div>
				) : (
					<div className={addAgentSetupClasses.waiting}>
						<span className={addAgentSetupClasses.waitingIndicator}>
							<span className={addAgentSetupClasses.waitingPulse} />
							<span className={addAgentSetupClasses.waitingDot} />
						</span>
						Waiting for your agent to connect…
					</div>
				)}
			</div>
		</div>
	);
}

function CommandSteps({
	steps,
	numbered = false,
}: {
	steps: ReadonlyArray<{ title: string; code: string; description: string }>;
	numbered?: boolean;
}) {
	return (
		<div className={addAgentSetupClasses.steps}>
			{steps.map((step, index) => (
				<div key={step.title} className={addAgentSetupClasses.step}>
					{numbered ? <StepNumber n={index + 1} /> : null}
					<div className={addAgentSetupClasses.body}>
						<div className={addAgentSetupClasses.title}>{step.title}</div>
						<div className={addAgentSetupClasses.commandRow}>
							<code className={addAgentSetupClasses.command}>{step.code}</code>
							<CopyButton text={step.code} label={`Copy ${step.title} command`} />
						</div>
						<p className={addAgentSetupClasses.requirementHint}>{step.description}</p>
					</div>
				</div>
			))}
		</div>
	);
}

function StepNumber({ n }: { n: number }) {
	return <span className={addAgentSetupClasses.stepNumber}>{n}</span>;
}
