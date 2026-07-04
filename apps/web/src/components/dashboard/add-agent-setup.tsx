"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentLabel, AgentSourceBadgeForEnvironment } from "@/components/dashboard/agent-label";
import { Button } from "@/components/ui/button";
import { unwrap, useApi } from "@/lib/api";
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

// One paste connects the machine: install, authorize (opens the browser),
// then auto-detect every local agent and start the sync daemons.
const ONE_COMMAND = "bun add -g clawdi && clawdi auth login && clawdi setup";

const CLI_STEPS = [
	{
		title: "Install the CLI",
		code: "bun add -g clawdi",
		description: "Or use npm: npm install -g clawdi",
	},
	{
		title: "Log in",
		code: "clawdi auth login",
		description: "Opens your browser to authorize this machine.",
	},
	{
		title: "Connect and enable sync",
		code: "clawdi setup",
		description:
			"Detects Claude Code / Codex / Hermes / OpenClaw, registers each one with your account, and installs the background daemon by default.",
	},
	{
		title: "Check live sync",
		code: "clawdi daemon status",
		description:
			"Shows the daemon state for every registered agent. If you opted out during setup, run `clawdi daemon install`.",
	},
	{
		title: "One-time history backup (optional)",
		code: "clawdi push --modules sessions --all-agents --all",
		description: "Uploads conversation history that existed before sync was on.",
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

function CopyButton({ text, className }: { text: string; className?: string }) {
	const { copied, copy } = useCopy();
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			onClick={() => copy(text)}
			className={cn("text-muted-foreground hover:text-foreground", className)}
			aria-label="Copy"
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</Button>
	);
}

/**
 * Connect-an-agent wizard (journey J7). One primary path — copy one
 * command — plus two quieter alternatives (send a prompt to the agent
 * itself, or step-by-step commands). While open it watches for newly
 * registered environments and flips into an explicit success card the
 * moment the agent checks in, so the win is designed rather than implied.
 *
 * Shared between `OnboardingCard` (Overview hero when no agents exist)
 * and `AddAgentDialog` (sidebar Quick Create).
 */
export function AddAgentSetup() {
	const api = useApi();
	const origin = useOrigin();
	const { copied, copy } = useCopy();
	const prompt = `Set up Clawdi on this machine. Fetch ${origin}/skill.md, and follow the skills to set it up. Finally, confirm the installation with \`clawdi doctor\`.`;

	// Live success detection: snapshot the env ids on first load, then poll
	// while mounted. Anything new is "your agent just connected".
	const envs = useQuery({
		queryKey: ["agents"],
		queryFn: async () => unwrap(await api.GET("/v1/agents")),
		refetchInterval: 5_000,
	});
	const baseline = useRef<Set<string> | null>(null);
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
			{/* Step 1 — the one command */}
			<div>
				<div className="flex items-center gap-2">
					<StepNumber n={1} />
					<span className="text-sm font-medium">Run this in a terminal on the machine</span>
				</div>
				<div className="mt-2 rounded-lg border bg-muted/30">
					<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
						<span className="text-2xs uppercase tracking-wider text-muted-foreground">
							One command
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => copy(ONE_COMMAND)}
							className="h-7 gap-1.5 px-2 text-xs"
						>
							{copied ? (
								<>
									<Check className="size-3.5" />
									Copied
								</>
							) : (
								<>
									<Copy className="size-3.5" />
									Copy
								</>
							)}
						</Button>
					</div>
					<pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-sm leading-relaxed">
						{ONE_COMMAND}
					</pre>
				</div>
				<p className="mt-1.5 text-xs text-muted-foreground">
					Installs the CLI, opens your browser to authorize, then finds Claude Code / Codex / Hermes
					/ OpenClaw on the machine and turns on live sync.
				</p>
			</div>

			{/* Step 2 — designed win moment */}
			<div>
				<div className="flex items-center gap-2">
					<StepNumber n={2} done={newAgents.length > 0} />
					<span className="text-sm font-medium">
						{newAgents.length > 0 ? "Agent connected" : "Watch it appear here"}
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
							Sessions from this machine sync automatically from now on.
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

			{/* Quieter alternatives */}
			<Disclosure summary="Prefer to let the AI set itself up? Send it this prompt">
				<div className="rounded-lg border bg-muted/30">
					<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
						<span className="text-2xs uppercase tracking-wider text-muted-foreground">Prompt</span>
						<CopyButton text={prompt} />
					</div>
					<pre className="whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed">{prompt}</pre>
				</div>
			</Disclosure>

			<Disclosure summary="Step-by-step commands">
				<div className="space-y-3">
					{CLI_STEPS.map((step, i) => (
						<div key={step.title} className="flex gap-3">
							<StepNumber n={i + 1} />
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">{step.title}</div>
								<div className="mt-1 flex items-center gap-1.5 rounded-md border bg-muted/30 px-3 py-1.5">
									<code className="flex-1 font-mono text-xs">{step.code}</code>
									<CopyButton text={step.code} />
								</div>
								{step.description ? (
									<p className="mt-1 text-xs text-muted-foreground">{step.description}</p>
								) : null}
							</div>
						</div>
					))}
				</div>
			</Disclosure>
		</div>
	);
}

function StepNumber({ n, done = false }: { n: number; done?: boolean }) {
	return (
		<span
			className={cn(
				"flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
				done ? "bg-success text-success-foreground" : "bg-primary/10 text-primary",
			)}
		>
			{done ? <Check className="size-3.5" /> : n}
		</span>
	);
}

function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronDown
					className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")}
				/>
				{summary}
			</button>
			{open ? <div className="mt-2">{children}</div> : null}
		</div>
	);
}
