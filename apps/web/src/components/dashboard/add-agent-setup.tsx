"use client";

import { Link } from "@tanstack/react-router";
import { Bot, Check, Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentLabel, AgentSourceBadgeForEnvironment } from "@/components/dashboard/agent-label";
import { agentRegistrationDescription } from "@/components/dashboard/agent-registration-status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOpenApi } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";

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

const CLI_STEPS = [
	{
		title: "Install the CLI",
		code: "npm install -g clawdi@latest",
		description: "Install the latest Clawdi CLI globally.",
	},
	{
		title: "Log in",
		code: "clawdi auth login",
		description: "Complete browser authorization before continuing to the next step.",
	},
	{
		title: "Connect and enable sync",
		code: "clawdi setup",
		description:
			"Detects Claude Code, Codex, Hermes, OpenClaw, Pi, and OpenCode; connects each one to your account and enables background sync.",
	},
];

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
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</Button>
	);
}

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
		<div className="space-y-4">
			<Tabs defaultValue="commands">
				<TabsList className="w-full sm:w-auto">
					<TabsTrigger value="commands">
						<Terminal data-icon="inline-start" /> Run commands
					</TabsTrigger>
					<TabsTrigger value="prompt">
						<Bot data-icon="inline-start" /> Ask your agent
					</TabsTrigger>
				</TabsList>
				<TabsContent value="commands" className="mt-2 space-y-4">
					<div>
						<p className="text-sm font-medium">Run these commands in order on the machine</p>
						<p className="mt-1 text-xs text-muted-foreground">Node.js 24+ is required.</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Prefer Bun? Use: bun add -g clawdi@latest
						</p>
					</div>
					<CommandSteps steps={CLI_STEPS} numbered />
				</TabsContent>
				<TabsContent value="prompt" className="mt-2 space-y-3">
					<div>
						<p className="text-sm font-medium">Ask your agent to set up Clawdi</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Paste this prompt into Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode on the
							machine.
						</p>
					</div>
					<div className="rounded-lg border bg-muted/30">
						<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
							<span className="text-2xs uppercase tracking-wider text-muted-foreground">
								Setup prompt
							</span>
							<CopyButton text={prompt} label="Copy prompt" />
						</div>
						<pre className="whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed">
							{prompt}
						</pre>
					</div>
				</TabsContent>
			</Tabs>

			<div className="border-t pt-4">
				<div className="flex items-center gap-2">
					{newAgents.length > 0 ? (
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground">
							<Check className="size-3.5" />
						</span>
					) : null}
					<span className="text-sm font-medium">
						{newAgents.length > 0 ? "Agent registered" : "Watch for your agent"}
					</span>
				</div>
				{newAgents.length > 0 ? (
					<div className="mt-2 space-y-2 rounded-lg border border-success/30 bg-success-muted p-3">
						{newAgents.map((env) => (
							<div key={env.id} className="flex items-center justify-between gap-3">
								<AgentLabel
									machineName={env.machine_name}
									displayName={env.display_name}
									defaultName={env.default_name}
									type={env.agent_type}
									avatarUrl={env.avatar_url}
									size="sm"
									titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
									className="min-w-0 flex-1"
								/>
								<Button
									render={<Link to="/agents/$id" params={{ id: env.id }} />}
									nativeButton={false}
									size="sm"
									variant="outline"
								>
									Open agent
								</Button>
							</div>
						))}
						<p className="text-xs text-success-muted-foreground">
							{agentRegistrationDescription(newAgents)}
						</p>
					</div>
				) : (
					<div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
						<span className="relative flex size-2">
							<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
							<span className="relative inline-flex size-2 rounded-full bg-primary" />
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
		<div className="space-y-3">
			{steps.map((step, index) => (
				<div key={step.title} className="flex gap-3">
					{numbered ? <StepNumber n={index + 1} /> : null}
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium">{step.title}</div>
						<div className="mt-1 flex items-center gap-1.5 rounded-md border bg-muted/30 px-3 py-1.5">
							<code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs">{step.code}</code>
							<CopyButton text={step.code} label={`Copy ${step.title} command`} />
						</div>
						<p className="mt-1 text-xs text-muted-foreground">{step.description}</p>
					</div>
				</div>
			))}
		</div>
	);
}

function StepNumber({ n }: { n: number }) {
	return (
		<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
			{n}
		</span>
	);
}
