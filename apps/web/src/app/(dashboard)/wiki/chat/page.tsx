"use client";

/**
 * Merged Chat + Deep Research surface.
 *
 *   wiki — POST /api/wiki/query (4-phase retrieval over local pages + LLM cite-by-number)
 *   web  — POST /api/wiki/research (OpenAI Responses + web_search_preview, optional save-to-wiki)
 *
 * One input, one history; the mode pill toggles which endpoint each new
 * question hits. Was previously two routes (/wiki and /wiki/research) —
 * collapsed here so the user doesn't context-switch between near-identical UIs.
 */

import { useAuth } from "@clerk/nextjs";
import { useMutation } from "@tanstack/react-query";
import {
	BookmarkPlus,
	Check,
	ExternalLink,
	Globe,
	Loader2,
	MessageSquare,
	Send,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, Fragment, useState } from "react";
import { Markdown } from "@/components/markdown";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

type Mode = "wiki" | "web";

type WikiCitation = { n: number; slug: string; title: string; snippet: string | null };
type WebCitation = { url: string; title: string };

type WikiResponse = {
	answer: string;
	citations: WikiCitation[];
	pages_considered: number;
	mode: "llm" | "no_llm" | "no_match";
};
type WebResponse = {
	answer: string;
	citations: WebCitation[];
	saved_slug: string | null;
	mode: "web_search" | "llm_only" | "no_llm";
};

type Turn =
	| { role: "user"; content: string; mode: Mode }
	| { role: "wiki"; content: string; citations: WikiCitation[]; mode_label: string }
	| {
			role: "web";
			content: string;
			citations: WebCitation[];
			saved_slug: string | null;
			mode_label: string;
	  };

export default function WikiChatPage() {
	const { getToken } = useAuth();
	const [input, setInput] = useState("");
	const [mode, setMode] = useState<Mode>("wiki");
	const [autoSaveWeb, setAutoSaveWeb] = useState(true);
	const [history, setHistory] = useState<Turn[]>([]);

	const askWiki = useMutation<WikiResponse, Error, string>({
		mutationFn: async (q) => {
			const token = (await getToken()) ?? "";
			const res = await fetch(`${API_URL}/api/wiki/query`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ q, top_k: 8, expand_graph: true }),
			});
			if (!res.ok) throw new Error(`Wiki query failed: ${res.status}`);
			return (await res.json()) as WikiResponse;
		},
		onSuccess: (data, q) => {
			setHistory((h) => [
				...h,
				{ role: "user", content: q, mode: "wiki" },
				{ role: "wiki", content: data.answer, citations: data.citations, mode_label: data.mode },
			]);
			setInput("");
		},
	});

	const askWeb = useMutation<WebResponse, Error, string>({
		mutationFn: async (q) => {
			const token = (await getToken()) ?? "";
			const res = await fetch(`${API_URL}/api/wiki/research`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ q, save: autoSaveWeb }),
			});
			if (!res.ok) throw new Error(`Research failed: ${res.status}`);
			return (await res.json()) as WebResponse;
		},
		onSuccess: (data, q) => {
			setHistory((h) => [
				...h,
				{ role: "user", content: q, mode: "web" },
				{
					role: "web",
					content: data.answer,
					citations: data.citations,
					saved_slug: data.saved_slug,
					mode_label: data.mode,
				},
			]);
			setInput("");
		},
	});

	const isPending = askWiki.isPending || askWeb.isPending;
	const error = askWiki.error || askWeb.error;

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (!input.trim() || isPending) return;
		if (mode === "wiki") askWiki.mutate(input.trim());
		else askWeb.mutate(input.trim());
	};

	return (
		<div className="max-w-3xl space-y-6 pb-24">
			<header className="space-y-3">
				<div className="flex items-center gap-2">
					<MessageSquare className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Chat</h1>
				</div>
				<p className="text-sm text-muted-foreground max-w-prose">
					Ask your wiki, or research on the web — both pipelines live here.
				</p>
				<div className="flex items-center gap-2 flex-wrap">
					<ModePill
						active={mode === "wiki"}
						onClick={() => setMode("wiki")}
						icon={<Sparkles className="size-3.5" />}
						label="Wiki"
						hint="local pages"
					/>
					<ModePill
						active={mode === "web"}
						onClick={() => setMode("web")}
						icon={<Globe className="size-3.5" />}
						label="Deep Research"
						hint="web-augmented"
					/>
					{mode === "web" && (
						<label className="ml-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
							<input
								type="checkbox"
								checked={autoSaveWeb}
								onChange={(e) => setAutoSaveWeb(e.target.checked)}
								className="rounded"
							/>
							Save result to wiki
						</label>
					)}
				</div>
			</header>

			{history.length === 0 ? (
				<div className="rounded-xl border border-dashed bg-card/50 p-8 text-center text-sm text-muted-foreground">
					{mode === "wiki" ? (
						<>
							Try: <em>&ldquo;What&rsquo;s the bot&rsquo;s name?&rdquo;</em> ·{" "}
							<em>&ldquo;Why does the voice agent fail?&rdquo;</em> ·{" "}
							<em>&ldquo;What&rsquo;s blocking the marvin-claw migration?&rdquo;</em>
						</>
					) : (
						<>
							Ask anything — the LLM searches the web, synthesizes findings, and can save the result
							as a wiki page.
						</>
					)}
				</div>
			) : (
				<div className="space-y-6">
					{history.map((turn, i) => {
						if (turn.role === "user") {
							return <UserBubble key={`u${i}`} text={turn.content} mode={turn.mode} />;
						}
						const previous = history[i - 1];
						const question = previous && previous.role === "user" ? previous.content : undefined;
						if (turn.role === "wiki") {
							return (
								<WikiAnswer
									key={`a${i}`}
									answer={turn.content}
									citations={turn.citations}
									mode_label={turn.mode_label}
									question={question}
								/>
							);
						}
						return (
							<WebAnswer
								key={`r${i}`}
								answer={turn.content}
								citations={turn.citations}
								saved_slug={turn.saved_slug}
								mode_label={turn.mode_label}
							/>
						);
					})}
				</div>
			)}

			{isPending && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					{mode === "wiki"
						? "Searching wiki, expanding graph, generating answer…"
						: "Searching the web, reading sources, synthesizing…"}
				</div>
			)}

			{error && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
					{error.message}
				</div>
			)}

			<form onSubmit={onSubmit} className="fixed bottom-6 left-0 right-0 mx-auto max-w-3xl px-4">
				<div className="flex items-center gap-2 rounded-xl border bg-background shadow-lg p-2">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder={mode === "wiki" ? "Ask your wiki…" : "Research the web…"}
						disabled={isPending}
						className="flex-1 bg-transparent px-3 py-2 text-sm focus:outline-none"
					/>
					<button
						type="submit"
						disabled={!input.trim() || isPending}
						className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
					>
						<Send className="size-4" />
						{mode === "wiki" ? "Ask" : "Research"}
					</button>
				</div>
			</form>
		</div>
	);
}

function ModePill({
	active,
	onClick,
	icon,
	label,
	hint,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	hint: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors",
				active
					? "bg-primary/10 border-primary/30 text-foreground"
					: "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70",
			)}
		>
			{icon}
			<span>{label}</span>
			<span className="text-[10px] opacity-60">·</span>
			<span className="text-[10px] opacity-60">{hint}</span>
		</button>
	);
}

function UserBubble({ text, mode }: { text: string; mode: Mode }) {
	return (
		<div className="flex justify-end items-start gap-2">
			<div className="max-w-[80%] rounded-xl bg-primary text-primary-foreground px-4 py-2.5 text-sm">
				{text}
			</div>
			<span className="text-[10px] text-muted-foreground mt-2 inline-flex items-center gap-1">
				{mode === "wiki" ? <Sparkles className="size-3" /> : <Globe className="size-3" />}
				{mode}
			</span>
		</div>
	);
}

function WikiAnswer({
	answer,
	citations,
	mode_label,
	question,
}: {
	answer: string;
	citations: WikiCitation[];
	mode_label: string;
	question?: string;
}) {
	return (
		<div className="space-y-2">
			<div className="rounded-xl border bg-card p-4 prose prose-sm dark:prose-invert max-w-none">
				<Markdown content={answer} />
			</div>
			{question && <SaveToWikiButton question={question} answer={answer} citations={citations} />}
			{citations.length > 0 && (
				<div className="text-xs space-y-1">
					<div className="text-muted-foreground font-medium uppercase tracking-wide">
						Cited pages
					</div>
					<ol className="space-y-0.5">
						{citations.map((c) => (
							<li key={c.n} className="flex items-baseline gap-2">
								<span className="text-muted-foreground font-mono">[{c.n}]</span>
								<Link href={`/wiki/${c.slug}`} className="hover:underline font-medium">
									{c.title}
								</Link>
								{c.snippet && (
									<Fragment>
										<span className="text-muted-foreground">—</span>
										<span className="text-muted-foreground line-clamp-1">{c.snippet}</span>
									</Fragment>
								)}
							</li>
						))}
					</ol>
				</div>
			)}
			{mode_label !== "llm" && (
				<div className="text-xs text-muted-foreground italic">Mode: {mode_label}</div>
			)}
		</div>
	);
}

function WebAnswer({
	answer,
	citations,
	saved_slug,
	mode_label,
}: {
	answer: string;
	citations: WebCitation[];
	saved_slug: string | null;
	mode_label: string;
}) {
	return (
		<div className="space-y-3">
			{mode_label === "llm_only" && (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
					Web search unavailable on this deployment — answered from training knowledge only.
				</div>
			)}
			{mode_label === "no_llm" && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
					LLM not configured on the backend.
				</div>
			)}
			{saved_slug && (
				<div className="rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-700 dark:text-green-400 inline-flex items-center gap-2">
					<Check className="size-3.5" />
					Saved as
					<Link href={`/wiki/${saved_slug}`} className="font-medium hover:underline">
						{saved_slug}
					</Link>
				</div>
			)}
			<div className="rounded-xl border bg-card p-4 prose prose-sm dark:prose-invert max-w-none">
				<Markdown content={answer} />
			</div>
			{citations.length > 0 && (
				<div className="text-xs space-y-1">
					<div className="text-muted-foreground font-medium uppercase tracking-wide">
						Web sources ({citations.length})
					</div>
					<ol className="space-y-0.5">
						{citations.map((c, i) => (
							<li key={`${c.url}-${i}`} className="flex items-baseline gap-2">
								<span className="text-muted-foreground font-mono">[{i + 1}]</span>
								<a
									href={c.url}
									target="_blank"
									rel="noreferrer"
									className="hover:underline inline-flex items-center gap-1 truncate"
								>
									<span className="truncate">{c.title || c.url}</span>
									<ExternalLink className="size-3 shrink-0 opacity-60" />
								</a>
							</li>
						))}
					</ol>
				</div>
			)}
		</div>
	);
}

function SaveToWikiButton({
	question,
	answer,
	citations,
}: {
	question: string;
	answer: string;
	citations: WikiCitation[];
}) {
	const { getToken } = useAuth();
	const [saved, setSaved] = useState<{ slug: string } | null>(null);

	const save = useMutation<{ slug: string; title: string; created: boolean }, Error, void>({
		mutationFn: async () => {
			const token = (await getToken()) ?? "";
			const citationsBlock = citations.length
				? `\n\n## Cited\n${citations.map((c) => `- [${c.n}] [${c.title}](/wiki/${c.slug})`).join("\n")}`
				: "";
			const body = `**Q:** ${question}\n\n${answer}${citationsBlock}`;
			const res = await fetch(`${API_URL}/api/wiki/save`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					title: question.length > 80 ? `${question.slice(0, 77)}...` : question,
					content: body,
					kind: "synthesis",
				}),
			});
			if (!res.ok) throw new Error(`Save failed: ${res.status}`);
			return (await res.json()) as { slug: string; title: string; created: boolean };
		},
		onSuccess: (data) => setSaved({ slug: data.slug }),
	});

	if (saved) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Check className="size-3.5 text-green-600 dark:text-green-400" />
				Saved as
				<Link href={`/wiki/${saved.slug}`} className="font-medium text-foreground hover:underline">
					{saved.slug}
				</Link>
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => save.mutate()}
			disabled={save.isPending}
			className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border bg-background hover:bg-accent/50 transition-colors disabled:opacity-50"
		>
			{save.isPending ? (
				<Loader2 className="size-3 animate-spin" />
			) : (
				<BookmarkPlus className="size-3" />
			)}
			Save to wiki
		</button>
	);
}
