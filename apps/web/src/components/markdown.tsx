"use client";

import { markdownPlugins } from "@clawdi/shared/markdown";
import { markdownClasses } from "@clawdi/shared/ui";
import { Check, Copy } from "lucide-react";
import {
	Children,
	type ComponentPropsWithoutRef,
	createContext,
	isValidElement,
	memo,
	type ReactElement,
	type ReactNode,
	useContext,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { createSearchHighlighter, SEARCH_MARK_CLASS } from "@/lib/search-highlight";
import { cn } from "@/lib/utils";

/**
 * Tracks whether we're rendering inside a fenced `<pre>`. The `code` override
 * uses this to decide between inline-code styling and naked passthrough — using
 * `className?.startsWith("language-")` alone misses two real cases:
 *   - ``` ``` (no language) — react-markdown emits `<code>` with no className
 *   - rehype plugins that decorate inline code with a non-language className
 */
const InsidePreContext = createContext(false);

interface MarkdownAstNode {
	type: string;
	value?: string;
	children?: MarkdownAstNode[];
	data?: {
		hName?: string;
		hProperties?: Record<string, string>;
	};
}

function searchHighlightPlugin(query: string) {
	const highlight = createSearchHighlighter(query);
	return () => (tree: MarkdownAstNode) => {
		const visit = (node: MarkdownAstNode) => {
			if (!node.children) return;
			for (let index = 0; index < node.children.length; index++) {
				const child = node.children[index];
				if (child.type !== "text" || child.value === undefined) {
					visit(child);
					continue;
				}
				const parts = highlight(child.value);
				if (!parts.some((part) => part.highlighted)) continue;
				const replacement: MarkdownAstNode[] = parts.map((part) =>
					part.highlighted
						? {
								type: "searchHighlight",
								data: {
									hName: "mark",
									hProperties: {
										className: SEARCH_MARK_CLASS,
									},
								},
								children: [{ type: "text", value: part.text }],
							}
						: { type: "text", value: part.text },
				);
				node.children.splice(index, 1, ...replacement);
				index += replacement.length - 1;
			}
		};
		visit(tree);
	};
}

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
	// `children` may be a single element or an array (whitespace text nodes
	// can appear when remark plugins or fenced-block formatting introduce
	// gaps). Pick the first valid React element — that's the `<code>` we
	// care about for language + raw text extraction.
	const elements = Children.toArray(children).filter(isValidElement);
	const child = (elements[0] ?? null) as ReactElement<{
		className?: string;
		children?: ReactNode;
	}> | null;
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
		<InsidePreContext.Provider value={true}>
			<div className={markdownClasses.codeFrame}>
				<div className={markdownClasses.codeHeader}>
					<span className={markdownClasses.codeLanguage}>{lang ?? "text"}</span>
					<button
						type="button"
						onClick={() => copy(code)}
						aria-label={`Copy ${lang ?? "code"}`}
						className={markdownClasses.copyAction}
					>
						{copied ? (
							<Check className={markdownClasses.copyIcon} />
						) : (
							<Copy className={markdownClasses.copyIcon} />
						)}
					</button>
				</div>
				<pre className={markdownClasses.codeBody}>{children}</pre>
			</div>
		</InsidePreContext.Provider>
	);
}

/**
 * Inline `<code>` styling. When rendered inside a fenced `<pre>` block we
 * pass through — `CodeBlockFrame` already provides the boxed wrapper, and
 * applying the inline-code border/padding here would draw a second frame
 * around the code text. The `InsidePreContext` flag is the source of truth;
 * we don't rely on `className` because:
 *   - fenced blocks without a language have no className at all
 *   - rehype/remark plugins can decorate inline code with non-language classes
 */
function InlineCode({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
	const insidePre = useContext(InsidePreContext);
	if (insidePre) {
		return (
			<code className={className} {...props}>
				{children}
			</code>
		);
	}
	return (
		<code className={markdownClasses.inlineCode} {...props}>
			{children}
		</code>
	);
}

function MarkdownImpl({ content, highlightQuery }: { content: string; highlightQuery?: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[
				...markdownPlugins,
				...(highlightQuery ? [searchHighlightPlugin(highlightQuery)] : []),
			]}
			components={{
				h1: ({ className, ...props }) => (
					<h1 className={cn(markdownClasses.h1, className)} {...props} />
				),
				h2: ({ className, ...props }) => (
					<h2 className={cn(markdownClasses.h2, className)} {...props} />
				),
				h3: ({ className, ...props }) => (
					<h3 className={cn(markdownClasses.h3, className)} {...props} />
				),
				p: ({ className, ...props }) => (
					<p className={cn(markdownClasses.paragraph, className)} {...props} />
				),
				a: ({ className, ...props }) => (
					<a
						className={cn(markdownClasses.link, className)}
						target="_blank"
						rel="noopener noreferrer"
						{...props}
					/>
				),
				ul: ({ className, ...props }) => (
					<ul className={cn(markdownClasses.unorderedList, className)} {...props} />
				),
				ol: ({ className, ...props }) => (
					<ol className={cn(markdownClasses.orderedList, className)} {...props} />
				),
				li: ({ className, ...props }) => (
					<li className={cn(markdownClasses.listItem, className)} {...props} />
				),
				blockquote: ({ className, ...props }) => (
					<blockquote className={cn(markdownClasses.blockquote, className)} {...props} />
				),
				table: ({ className, ...props }) => (
					<div className={markdownClasses.tableContainer}>
						<table className={cn(markdownClasses.table, className)} {...props} />
					</div>
				),
				th: ({ className, ...props }) => (
					<th className={cn(markdownClasses.tableHeader, className)} {...props} />
				),
				td: ({ className, ...props }) => (
					<td className={cn(markdownClasses.tableCell, className)} {...props} />
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
