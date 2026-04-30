"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Loader2, MessageSquare, Send } from "lucide-react";
import Link from "next/link";
import { type FormEvent, Fragment, useState } from "react";
import { Markdown } from "@/components/markdown";
import { API_URL } from "@/lib/api";

type Citation = {
	n: number;
	slug: string;
	title: string;
	snippet: string | null;
};

type QueryResponse = {
	answer: string;
	citations: Citation[];
	pages_considered: number;
	mode: "llm" | "no_llm" | "no_match";
};

type ChatMessage = {
	role: "user" | "wiki";
	content: string;
	citations?: Citation[];
	mode?: string;
};

export default function WikiChatPage() {
	const { getToken } = useAuth();
	const [input, setInput] = useState("");
	const [history, setHistory] = useState<ChatMessage[]>([]);

	const askWiki = useMutation<QueryResponse, Error, string>({
		mutationFn: async (q) => {
			const token = (await getToken()) ?? "";
			const res = await fetch(`${API_URL}/api/wiki/query`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ q, top_k: 8, expand_graph: true }),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Wiki query failed: ${res.status} ${text.slice(0, 200)}`);
			}
			return (await res.json()) as QueryResponse;
		},
		onSuccess: (data, q) => {
			setHistory((h) => [
				...h,
				{ role: "user", content: q },
				{ role: "wiki", content: data.answer, citations: data.citations, mode: data.mode },
			]);
			setInput("");
		},
	});

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (!input.trim() || askWiki.isPending) return;
		askWiki.mutate(input.trim());
	};

	return (
		<div className="max-w-3xl mx-auto space-y-6 pb-24">
			<Link
				href="/wiki"
				className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
			>
				<ArrowLeft className="size-4" />
				Back to wiki
			</Link>

			<header className="space-y-2">
				<div className="flex items-center gap-2">
					<MessageSquare className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Chat with your wiki</h1>
				</div>
				<p className="text-sm text-muted-foreground max-w-prose">
					Ask questions across your synthesized knowledge. The wiki retrieves the most relevant
					entity pages, expands the graph one hop, and answers with cited page numbers.
				</p>
			</header>

			{/* Conversation */}
			{history.length === 0 ? (
				<div className="rounded-xl border border-dashed bg-card/50 p-8 text-center text-sm text-muted-foreground">
					Try: <em>"What's the bot's name?"</em> · <em>"Why does the voice agent fail?"</em> ·
					<em> "What's blocking the marvin-claw migration?"</em>
				</div>
			) : (
				<div className="space-y-6">
					{history.map((msg, i) => (
						<MessageBubble key={`${i}-${msg.role}-${msg.content.slice(0, 12)}`} msg={msg} />
					))}
				</div>
			)}

			{askWiki.isPending && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Searching wiki, expanding graph, generating answer…
				</div>
			)}

			{askWiki.isError && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
					{askWiki.error.message}
				</div>
			)}

			<form onSubmit={onSubmit} className="fixed bottom-6 left-0 right-0 mx-auto max-w-3xl px-4">
				<div className="flex items-center gap-2 rounded-xl border bg-background shadow-lg p-2">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Ask your wiki…"
						disabled={askWiki.isPending}
						className="flex-1 bg-transparent px-3 py-2 text-sm focus:outline-none"
					/>
					<button
						type="submit"
						disabled={!input.trim() || askWiki.isPending}
						className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
					>
						<Send className="size-4" />
						Ask
					</button>
				</div>
			</form>
		</div>
	);
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
	if (msg.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[80%] rounded-xl bg-primary text-primary-foreground px-4 py-2.5 text-sm">
					{msg.content}
				</div>
			</div>
		);
	}
	return (
		<div className="space-y-2">
			<div className="rounded-xl border bg-card p-4 prose prose-sm dark:prose-invert max-w-none">
				<Markdown content={msg.content} />
			</div>
			{msg.citations && msg.citations.length > 0 && (
				<div className="text-xs space-y-1">
					<div className="text-muted-foreground font-medium uppercase tracking-wide">
						Cited pages
					</div>
					<ol className="space-y-0.5">
						{msg.citations.map((c) => (
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
			{msg.mode && msg.mode !== "llm" && (
				<div className="text-xs text-muted-foreground italic">
					Mode: {msg.mode}
					{msg.mode === "no_llm" && " — set LLM_API_KEY on the backend to enable answers."}
				</div>
			)}
		</div>
	);
}
