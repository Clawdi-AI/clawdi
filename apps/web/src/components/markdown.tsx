"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Check, Copy } from "lucide-react";
import { type ComponentPropsWithoutRef, memo, useState } from "react";
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

function CodeBlock({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code">) {
  const { copied, copy } = useCopyToClipboard();
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1];
  const code = String(children).replace(/\n$/, "");
  const isInline = !className && !String(children).includes("\n");

  if (isInline) {
    return (
      <code
        className="rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-border/50 bg-muted/50 px-3 py-1.5 text-xs">
        <span className="font-medium text-muted-foreground lowercase">
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={() => copy(code)}
          className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <code className={cn("text-xs", className)} {...props}>
        {children}
      </code>
    </>
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
          <ol className={cn("mb-2 ml-4 list-decimal last:mb-0 [&>li]:mt-1", className)} {...props} />
        ),
        li: ({ className, ...props }) => (
          <li className={cn("leading-normal", className)} {...props} />
        ),
        blockquote: ({ className, ...props }) => (
          <blockquote
            className={cn("mb-2 border-l-2 border-border pl-3 italic text-muted-foreground", className)}
            {...props}
          />
        ),
        table: ({ className, ...props }) => (
          <div className="mb-2 overflow-x-auto">
            <table className={cn("w-full border-collapse text-sm", className)} {...props} />
          </div>
        ),
        th: ({ className, ...props }) => (
          <th className={cn("border border-border px-3 py-1.5 text-left font-medium bg-muted/50", className)} {...props} />
        ),
        td: ({ className, ...props }) => (
          <td className={cn("border border-border px-3 py-1.5", className)} {...props} />
        ),
        pre: ({ className, ...props }) => (
          <pre
            className={cn(
              "mb-2 overflow-x-auto rounded-b-lg border border-t-0 border-border/50 bg-muted/30 p-3 leading-relaxed font-mono",
              className,
            )}
            {...props}
          />
        ),
        code: CodeBlock,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export const Markdown = memo(MarkdownImpl);
