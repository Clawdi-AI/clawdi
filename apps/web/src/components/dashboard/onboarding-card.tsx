"use client";

import { Check, Copy, Rocket, Terminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, errorMessage } from "@/lib/utils";

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

export function OnboardingCard() {
	return (
		<Card id="add-agent" className="scroll-mt-20">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Rocket className="size-5 text-primary" />
					Add an agent
				</CardTitle>
				<CardDescription>
					Connect another machine or agent type — works for Claude Code, Codex, Hermes and OpenClaw.
				</CardDescription>
			</CardHeader>
			<CardContent>
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
			</CardContent>
		</Card>
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

			<div className="relative rounded-lg border bg-muted/30 p-4">
				<pre className="whitespace-pre-wrap pr-10 font-mono text-sm">{prompt}</pre>
				<Button
					variant="outline"
					size="sm"
					onClick={() => copy(prompt)}
					className="absolute right-3 top-3"
				>
					{copied ? (
						<>
							<Check />
							Copied
						</>
					) : (
						<>
							<Copy />
							Copy
						</>
					)}
				</Button>
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
						<p className="mt-1 text-xs text-muted-foreground">{step.description}</p>
					</div>
				</div>
			))}
		</div>
	);
}
