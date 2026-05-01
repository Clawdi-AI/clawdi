"use client";

/**
 * Empty-state guidance card with the same dual-path pattern as the
 * "Add an agent" flow: one tab tells the user's AI agent what to
 * do (copy-paste prompt), the other shows the manual CLI commands
 * for power users who'd rather drive it themselves.
 *
 * Use this anywhere the empty state requires the user (or their
 * agent) to take an action — Skills, Vault, etc. The pure friendly
 * sentence ("Once your agent has a conversation, it'll show up
 * here") still belongs on read-only views like Sessions where the
 * data appears as a side effect of agent activity, not because the
 * user did something.
 */

import { Check, Copy, Rocket, Terminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, errorMessage } from "@/lib/utils";

export interface CliStep {
	title: string;
	code: string;
	description?: string;
}

interface Props {
	/** Heading shown above the tabs. Two short sentences max. */
	intro?: string;
	/** Plain-text prompt the user copies into their AI agent. */
	agentPrompt: string;
	/** Steps for the manual CLI path. */
	cliSteps: CliStep[];
}

export function EmptyStateGuidance({ intro, agentPrompt, cliSteps }: Props) {
	return (
		<div className="space-y-4">
			{intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
			<Tabs defaultValue="agent" className="w-full">
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
					<AgentPromptTab prompt={agentPrompt} />
				</TabsContent>
				<TabsContent value="cli">
					<CliStepsTab steps={cliSteps} />
				</TabsContent>
			</Tabs>
		</div>
	);
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

function AgentPromptTab({ prompt }: { prompt: string }) {
	const { copied, copy } = useCopy();
	return (
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
	);
}

function CliStepsTab({ steps }: { steps: CliStep[] }) {
	return (
		<div className="space-y-3">
			{steps.map((step, i) => (
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

function CopyButton({ text }: { text: string }) {
	const { copied, copy } = useCopy();
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			onClick={() => copy(text)}
			className={cn("text-muted-foreground hover:text-foreground")}
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
