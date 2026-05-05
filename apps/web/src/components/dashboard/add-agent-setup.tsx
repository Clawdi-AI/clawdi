"use client";

import { Check, Copy, Rocket, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, errorMessage } from "@/lib/utils";

// Fallback origin used during SSR and on the first client render before the
// useEffect fires, so server and client markup match. The real origin is
// swapped in post-mount.
const DEFAULT_ORIGIN = "https://cloud.clawdi.ai";

function useAgentPrompt() {
	const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);
	return `Set up Clawdi on this machine. Fetch ${origin}/skill.md, and follow the skills to set it up. Finally, confirm the installation with \`clawdi doctor\`.`;
}

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
		title: "Connect this agent",
		code: "clawdi setup",
		description:
			"Detects Claude Code / Codex / Hermes / OpenClaw, registers each one with your account.",
	},
	{
		title: "Turn on live sync",
		code: "clawdi serve install --all",
		description:
			"Installs a tiny background service per registered agent — Claude Code, Codex, OpenClaw, Hermes — so anything you change here lands on the machine in seconds, and vice versa. To install for one agent, replace `--all` with `--agent <name>`.",
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

function StepNumber({ n }: { n: number }) {
	return (
		<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
			{n}
		</span>
	);
}

/**
 * Tabs + steps body for adding an agent. Shared between:
 *   - `OnboardingCard` (renders it as the Overview hero card when the user
 *     has no agents yet)
 *   - `AddAgentDialog` (opened from the sidebar Quick Create button, for
 *     users who already have an agent and want to connect another)
 */
export function AddAgentSetup() {
	return (
		<Tabs defaultValue="agent">
			<TabsList>
				<TabsTrigger value="agent">
					<Rocket />
					Send to Agent
				</TabsTrigger>
				<TabsTrigger value="cli">
					<Terminal />
					Manual Setup
				</TabsTrigger>
			</TabsList>
			<TabsContent value="agent">
				<AgentTab />
			</TabsContent>
			<TabsContent value="cli">
				<CliTab />
			</TabsContent>
		</Tabs>
	);
}

function AgentTab() {
	const { copied, copy } = useCopy();
	const prompt = useAgentPrompt();

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Copy this prompt and send it to your AI agent (Claude Code, Codex, OpenClaw, or Hermes):
			</p>

			<div className="rounded-lg border bg-muted/30">
				<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
					<span className="text-xs uppercase tracking-wide text-muted-foreground">Prompt</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => copy(prompt)}
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
				<pre className="whitespace-pre-wrap p-4 font-mono text-sm leading-relaxed">{prompt}</pre>
			</div>

			<div className="flex flex-col gap-3">
				{[
					"Send this prompt to your AI agent",
					"The agent reads the skill and configures itself",
					"Come back here — your sessions and tools will appear",
				].map((step, i) => (
					<div key={step} className="flex items-center gap-3">
						<StepNumber n={i + 1} />
						<span className="text-sm">{step}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function CliTab() {
	return (
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
	);
}
