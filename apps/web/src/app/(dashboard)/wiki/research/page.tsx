"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Markdown } from "@/components/markdown";
import { API_URL } from "@/lib/api";

type WebCitation = { url: string; title: string };
type ResearchResponse = {
	answer: string;
	citations: WebCitation[];
	saved_slug: string | null;
	mode: "web_search" | "llm_only" | "no_llm";
};

export default function DeepResearchPage() {
	const { getToken } = useAuth();
	const [query, setQuery] = useState("");
	const [autoSave, setAutoSave] = useState(true);

	const research = useMutation<ResearchResponse, Error, string>({
		mutationFn: async (q) => {
			const token = (await getToken()) ?? "";
			const res = await fetch(`${API_URL}/api/wiki/research`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ q, save: autoSave }),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Research failed: ${res.status} ${text.slice(0, 200)}`);
			}
			return (await res.json()) as ResearchResponse;
		},
	});

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (!query.trim() || research.isPending) return;
		research.mutate(query.trim());
	};

	const result = research.data;

	return (
		<div className="max-w-3xl space-y-6 pb-24">
			<header className="space-y-2">
				<div className="flex items-center gap-2">
					<Sparkles className="size-5 text-muted-foreground" />
					<h1 className="text-xl font-semibold">Deep research</h1>
				</div>
				<p className="text-xs text-muted-foreground max-w-prose">
					Ask a question that goes beyond what's in your wiki — the LLM searches the web,
					synthesizes the findings, and (optionally) saves the result as a wiki page so it joins the
					rest of your knowledge graph.
				</p>
			</header>

			<form onSubmit={onSubmit} className="space-y-3">
				<div className="relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="What do you want to research?"
						disabled={research.isPending}
						className="w-full pl-9 pr-3 py-3 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
					/>
				</div>
				<div className="flex items-center justify-between flex-wrap gap-3">
					<label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
						<input
							type="checkbox"
							checked={autoSave}
							onChange={(e) => setAutoSave(e.target.checked)}
							className="rounded"
						/>
						Save result to wiki
					</label>
					<button
						type="submit"
						disabled={!query.trim() || research.isPending}
						className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
					>
						{research.isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Sparkles className="size-4" />
						)}
						Research
					</button>
				</div>
			</form>

			{research.isPending && (
				<div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2">
					<Loader2 className="size-4 animate-spin" />
					Searching the web, reading sources, synthesizing…
				</div>
			)}

			{research.isError && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
					{research.error.message}
				</div>
			)}

			{result && (
				<div className="space-y-4">
					{/* Mode banner */}
					{result.mode === "llm_only" && (
						<div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
							Web search unavailable on this deployment — answered from training knowledge only.
						</div>
					)}
					{result.mode === "no_llm" && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
							LLM not configured. Set LLM_API_KEY on the backend.
						</div>
					)}
					{result.saved_slug && (
						<div className="rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-700 dark:text-green-400 inline-flex items-center gap-2">
							<Check className="size-3.5" />
							Saved as
							<Link href={`/wiki/${result.saved_slug}`} className="font-medium hover:underline">
								{result.saved_slug}
							</Link>
						</div>
					)}

					{/* Answer */}
					<div className="rounded-xl border bg-card p-4 prose prose-sm dark:prose-invert max-w-none">
						<Markdown content={result.answer} />
					</div>

					{/* Web citations */}
					{result.citations.length > 0 && (
						<div className="text-xs space-y-1">
							<div className="text-muted-foreground font-medium uppercase tracking-wide">
								Sources ({result.citations.length})
							</div>
							<ol className="space-y-0.5">
								{result.citations.map((c, i) => (
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
			)}
		</div>
	);
}
