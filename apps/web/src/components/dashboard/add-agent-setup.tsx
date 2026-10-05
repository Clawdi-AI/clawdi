"use client";
import { addAgentSetupClasses } from "@clawdi/shared/ui";
import {
	agentRegistrationDescription,
	agentSurfaceCopy,
	CLI_STEPS,
	errorMessage,
} from "@clawdi/shared/view";
import { Link } from "@tanstack/react-router";
import { Bot, Check, Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentLabel, AgentSourceBadgeForEnvironment } from "@/components/dashboard/agent-label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOpenApi } from "@/lib/api";
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

function useCopy(duration = 2000) {
	const [copied, setCopied] = useState(false);
	const copy = (text: string) => {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), duration);
			})
			.catch((e) => toast.error("Copy failed", { description: errorMessage(e) }));
	};
	return { copied, copy };
}

function CopyButton({
	text,
	label,
	className,
}: {
	text: string;
	label: string;
	className?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			onClick={() => copy(text)}
			className={cn("text-muted-foreground hover:text-foreground", className)}
			aria-label={label}
		>
			{copied ? (
				<Check className={addAgentSetupClasses.size} />
			) : (
				<Copy className={addAgentSetupClasses.size} />
			)}
		</Button>
	);
}

/**
 * Shared setup body for every `AddAgentDialog`. Commands and the agent
 * hand-off prompt are peer paths; while the dialog is open, the setup also
 * watches for newly registered agents and surfaces an explicit success state.
 */
export function AddAgentSetup() {
	const api = useOpenApi();
	const origin = useOrigin();
	const prompt = `Set up Clawdi on this machine. Fetch ${origin}/skill.md, and follow the skills to set it up. Finally, confirm the installation with \`clawdi doctor\`.`;
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
		<div className={addAgentSetupClasses.spaceY}>
			<Tabs defaultValue="commands">
				<TabsList className={addAgentSetupClasses.wFullSmW}>
					<TabsTrigger value="commands">
						<Terminal data-icon="inline-start" /> Run commands
					</TabsTrigger>
					<TabsTrigger value="prompt">
						<Bot data-icon="inline-start" /> Ask your agent
					</TabsTrigger>
				</TabsList>
				<TabsContent value="commands" className={addAgentSetupClasses.mtSpaceY}>
					<div>
						<p className={addAgentSetupClasses.textSmFontMedium}>
							{agentSurfaceCopy.runTheseCommandsInOrderOnTheMachine}
						</p>
						<p className={addAgentSetupClasses.mtTextXsText}>
							{agentSurfaceCopy.nodeJs24IsRequired}
						</p>
						<p className={addAgentSetupClasses.mtTextXsText2}>
							{agentSurfaceCopy.preferBunUseBunAddGClawdiLatest}
						</p>
					</div>
					<CommandSteps steps={CLI_STEPS} numbered />
				</TabsContent>
				<TabsContent value="prompt" className={addAgentSetupClasses.mtSpaceY2}>
					<div>
						<p className={addAgentSetupClasses.textSmFontMedium}>
							{agentSurfaceCopy.askYourAgentToSetUpClawdi}
						</p>
						<p className={addAgentSetupClasses.mtTextXsText}>
							{agentSurfaceCopy.pasteThisPromptIntoClaudeCodeCodexHermesOpenClaw}
						</p>
					</div>
					<div className={addAgentSetupClasses.roundedLgBorderBg}>
						<div className={addAgentSetupClasses.flexItemsCenterJustify}>
							<span className={addAgentSetupClasses.textXsUppercaseTracking}>
								{agentSurfaceCopy.setupPrompt}
							</span>
							<CopyButton text={prompt} label="Copy prompt" />
						</div>
						<pre className={addAgentSetupClasses.whitespacePreWrapP}>{prompt}</pre>
					</div>
				</TabsContent>
			</Tabs>

			<div className={addAgentSetupClasses.borderTPt}>
				<div className={addAgentSetupClasses.flexItemsCenterGap}>
					{newAgents.length > 0 ? (
						<span className={addAgentSetupClasses.flexSizeShrinkItems}>
							<Check className={addAgentSetupClasses.size} />
						</span>
					) : null}
					<span className={addAgentSetupClasses.textSmFontMedium}>
						{newAgents.length > 0
							? agentSurfaceCopy.agentRegistered
							: agentSurfaceCopy.watchForYourAgent}
					</span>
				</div>
				{newAgents.length > 0 ? (
					<div className={addAgentSetupClasses.mtSpaceYRounded}>
						{newAgents.map((env) => (
							<div key={env.id} className={addAgentSetupClasses.flexItemsCenterJustify2}>
								<AgentLabel
									machineName={env.machine_name}
									displayName={env.display_name}
									defaultName={env.default_name}
									type={env.agent_type}
									avatarUrl={env.avatar_url}
									size="sm"
									titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
									className={addAgentSetupClasses.minWFlex}
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
						<p className={addAgentSetupClasses.textXsTextSuccess}>
							{agentRegistrationDescription(newAgents)}
						</p>
					</div>
				) : (
					<div className={addAgentSetupClasses.mtFlexItemsCenter}>
						<span className={addAgentSetupClasses.relativeFlexSize}>
							<span className={addAgentSetupClasses.absoluteInlineFlexH} />
							<span className={addAgentSetupClasses.relativeInlineFlexSize} />
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
		<div className={addAgentSetupClasses.spaceY2}>
			{steps.map((step, index) => (
				<div key={step.title} className={addAgentSetupClasses.flexGap}>
					{numbered ? <StepNumber n={index + 1} /> : null}
					<div className={addAgentSetupClasses.minWFlex}>
						<div className={addAgentSetupClasses.textSmFontMedium}>{step.title}</div>
						<div className={addAgentSetupClasses.mtFlexItemsCenter2}>
							<code className={addAgentSetupClasses.minWFlexOverflow}>{step.code}</code>
							<CopyButton text={step.code} label={`Copy ${step.title} command`} />
						</div>
						<p className={addAgentSetupClasses.mtTextXsText}>{step.description}</p>
					</div>
				</div>
			))}
		</div>
	);
}

function StepNumber({ n }: { n: number }) {
	return <span className={addAgentSetupClasses.flexSizeShrinkItems2}>{n}</span>;
}
