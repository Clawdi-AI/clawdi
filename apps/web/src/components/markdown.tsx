"use client";

import { Check, Copy } from "lucide-react";
import {
	type ComponentPropsWithoutRef,
	isValidElement,
	memo,
	type ReactElement,
	type ReactNode,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

function useCopyToClipboard(duration = 2000) {
	const [copied, setCopied] = useState(false);
	const copy = (text: string) => {
		navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), duration);
		});
	};
	return { copied, copy };
}

/**
 * Pull the `<code>`'s className + text content out of the `<pre>`'s children.
 * react-markdown always emits `<pre><code class="language-…">…</code></pre>`
 * for fenced blocks, but we render the frame at `<pre>` so we need to peek
 * at the child to know the language + grab the raw text for the Copy button.
 */
function extractCodeMeta(children: ReactNode): { lang: string | null; code: string } {
	const child = isValidElement(children)
		? (children as ReactElement<{ className?: string; children?: ReactNode }>)
		: null;
	const className = child?.props?.className ?? "";
	const match = /language-(\w+)/.exec(className);
	const lang = match?.[1] ?? null;
	const inner = child?.props?.children;
	const code = String(inner ?? "").replace(/\n$/, "");
	return { lang, code };
}

function CodeBlockFrame({ children }: { children?: ReactNode }) {
	const { copied, copy } = useCopyToClipboard();
	const { lang, code } = extractCodeMeta(children);
	return (
		<div className="my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
			<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-xs">
				<span className="font-medium text-muted-foreground lowercase">{lang ?? "text"}</span>
				<button
					type="button"
					onClick={() => copy(code)}
					aria-label={`Copy ${lang ?? "code"}`}
					className="p-0.5 text-muted-foreground transition-colors hover:text-foreground"
				>
					{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
				</button>
			</div>
			<pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{children}</pre>
		</div>
	);
}

/**
 * Inline `<code>` (no language). Block code is handed off to the `pre`
 * override above, which uses `CodeBlockFrame` to render the boxed UI.
 */
function InlineCode({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
	// react-markdown sets `language-…` on the `<code>` inside fenced blocks.
	// When that's present, we're being called from within `<pre>` — render
	// naked so the `pre` override can do the framing work.
	if (className) {
		return (
			<code className={className} {...props}>
				{children}
			</code>
		);
	}
	return (
		<code
			className="rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]"
			{...props}
		>
			{children}
		</code>
	);
}

function MarkdownImpl({ content }: { content: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkBreaks]}
			components={{
				h1: ({ className, ...props }) => (
					<h1 className={cn("mb-2 font-semibold text-base first:mt-0", className)} {...props} />
				),
				h2: ({ className, ...props }) => (
					<h2 className={cn("mb-2 font-semibold text-sm first:mt-0", className)} {...props} />
				),
				h3: ({ className, ...props }) => (
					<h3 className={cn("mb-1.5 font-semibold text-sm first:mt-0", className)} {...props} />
				),
				p: ({ className, ...props }) => (
					<p className={cn("mb-2 last:mb-0 leading-normal", className)} {...props} />
				),
				a: ({ className, ...props }) => (
					<a
						className={cn("text-primary underline underline-offset-2", className)}
						target="_blank"
						rel="noopener noreferrer"
						{...props}
					/>
				),
				ul: ({ className, ...props }) => (
					<ul className={cn("mb-2 ml-4 list-disc last:mb-0 [&>li]:mt-1", className)} {...props} />
				),
				ol: ({ className, ...props }) => (
					<ol
						className={cn("mb-2 ml-4 list-decimal last:mb-0 [&>li]:mt-1", className)}
						{...props}
					/>
				),
				li: ({ className, ...props }) => (
					<li className={cn("leading-normal", className)} {...props} />
				),
				blockquote: ({ className, ...props }) => (
					<blockquote
						className={cn(
							"mb-2 border-l-2 border-border pl-3 italic text-muted-foreground",
							className,
						)}
						{...props}
					/>
				),
				table: ({ className, ...props }) => (
					<div className="mb-2 overflow-x-auto">
						<table className={cn("w-full border-collapse text-sm", className)} {...props} />
					</div>
				),
				th: ({ className, ...props }) => (
					<th
						className={cn(
							"border border-border px-3 py-1.5 text-left font-medium bg-muted/50",
							className,
						)}
						{...props}
					/>
				),
				td: ({ className, ...props }) => (
					<td className={cn("border border-border px-3 py-1.5", className)} {...props} />
				),
				pre: CodeBlockFrame,
				code: InlineCode,
			}}
		>
			{content}
		</ReactMarkdown>
	);
}

export const Markdown = memo(MarkdownImpl);
