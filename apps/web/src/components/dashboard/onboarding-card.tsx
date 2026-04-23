"use client";

import { Check, Copy, Rocket, Terminal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function getAgentPrompt() {
	const origin = typeof window !== "undefined" ? window.location.origin : "https://cloud.clawdi.ai";
	return `Read ${origin}/skill.md and follow the instructions to connect to Clawdi Cloud.`;
}

const CLI_STEPS = [
	{
		title: "Install CLI",
		code: "bun add -g @clawdi-cloud/cli",
		description: "Or use npm: npm install -g @clawdi-cloud/cli",
	},
	{
		title: "Log in",
		code: "clawdi login",
		description: "Enter your API key from Settings → API Keys",
	},
	{
		title: "Set up agent",
		code: "clawdi setup",
		description: "Detects Claude Code, registers MCP server and installs skill",
	},
	{
		title: "Sync sessions",
		code: "clawdi sync up",
		description: "Upload your conversation history to the cloud",
	},
];

function useCopy(duration = 2000) {
	const [copied, setCopied] = useState(false);
	const copy = (text: string) => {
		navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), duration);
		});
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
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</Button>
	);
}

export function OnboardingCard() {
	const [tab, setTab] = useState<"agent" | "cli">("agent");

	return (
		<div className="rounded-xl border bg-card overflow-hidden">
			{/* Header */}
			<div className="px-6 pt-6 pb-4">
				<div className="flex items-center gap-2 mb-1">
					<Rocket className="size-5 text-primary" />
					<h2 className="text-lg font-semibold">Get Started</h2>
				</div>
				<p className="text-sm text-muted-foreground">
					Connect your AI agent to Clawdi Cloud in seconds.
				</p>
			</div>

			{/* Tabs */}
			<div className="flex border-b px-6">
				<Button
					variant="ghost"
					onClick={() => setTab("agent")}
					className={cn(
						"h-auto gap-1.5 rounded-none border-b-2 px-4 py-2 text-sm font-medium -mb-px hover:bg-transparent",
						tab === "agent"
							? "border-primary text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					<Rocket className="size-3.5" />
					Send to Agent
				</Button>
				<Button
					variant="ghost"
					onClick={() => setTab("cli")}
					className={cn(
						"h-auto gap-1.5 rounded-none border-b-2 px-4 py-2 text-sm font-medium -mb-px hover:bg-transparent",
						tab === "cli"
							? "border-primary text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					<Terminal className="size-3.5" />
					Manual Setup
				</Button>
			</div>

			{/* Content */}
			<div className="px-6 py-5">{tab === "agent" ? <AgentTab /> : <CliTab />}</div>
		</div>
	);
}

function AgentTab() {
	const { copied, copy } = useCopy();
	const prompt = getAgentPrompt();

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Copy this prompt and send it to your AI agent (Claude Code, Cursor, etc.):
			</p>

			{/* Prompt box */}
			<div className="relative rounded-lg border bg-muted/30 p-4">
				<pre className="text-sm whitespace-pre-wrap pr-8 font-mono">{prompt}</pre>
				<Button
					variant="outline"
					size="xs"
					onClick={() => copy(prompt)}
					className={cn(
						"absolute top-3 right-3",
						copied &&
							"border-transparent bg-green-500/10 text-green-600 hover:bg-green-500/10 hover:text-green-600",
					)}
				>
					{copied ? (
						<>
							<Check className="size-3" /> Copied
						</>
					) : (
						<>
							<Copy className="size-3" /> Copy
						</>
					)}
				</Button>
			</div>

			{/* Steps */}
			<div className="flex flex-col gap-3">
				{[
					"Send this prompt to your AI agent",
					"The agent reads the skill and configures itself",
					"Come back here — your sessions and tools will appear",
				].map((step, i) => (
					<div key={step} className="flex items-start gap-3">
						<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
							{i + 1}
						</span>
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
					<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary mt-0.5">
						{i + 1}
					</span>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium">{step.title}</div>
						<div className="flex items-center gap-1.5 mt-1 rounded-md border bg-muted/30 px-3 py-1.5">
							<code className="flex-1 text-xs font-mono">{step.code}</code>
							<CopyButton text={step.code} />
						</div>
						<p className="text-[11px] text-muted-foreground mt-1">{step.description}</p>
					</div>
				</div>
			))}
		</div>
	);
}
