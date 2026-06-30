"use client";

import { Check, FileJson, FileText, Link2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, errorMessage } from "@/lib/utils";

/**
 * Read-only share affordances for the public share page (`/s/{id}`).
 * Mirrors the owner-side `SessionShareControls` chrome but without the
 * visibility toggle — viewers may not be the owner, and the link already
 * works (server-side gate handles auth/permissions). The Markdown / JSON
 * URLs are the canonical agent-fetch entry points (see
 * `apps/web/src/pages/public-share/session-export-route.ts`).
 */
export function PublicShareControls({ sessionId }: { sessionId: string }) {
	const url = buildShareUrl(sessionId);
	return (
		<div className="flex items-center gap-1">
			<CopyLinkButton url={url} />
			<ExportMenu url={url} />
		</div>
	);
}

function buildShareUrl(sessionId: string): string {
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	return `${origin}/s/${sessionId}`;
}

function CopyLinkButton({ url }: { url: string }) {
	const { copied, copy } = useCopyToClipboard(url, "Link");
	return (
		<Button
			variant="outline"
			size="icon"
			// 36px on mobile (matches Button's default `size="icon"`), 32px
			// at `sm:` and up — denser desktop cluster, thumb-safe phone.
			className={cn("size-9 sm:size-8", copied && "text-success")}
			onClick={copy}
			aria-label="Copy share link"
			title="Copy share link"
		>
			{copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
		</Button>
	);
}

function ExportMenu({ url }: { url: string }) {
	const mdUrl = `${url}.md`;
	const jsonUrl = `${url}.json`;
	const { copy: copyMd } = useCopyToClipboard(mdUrl, "Markdown URL");
	const { copy: copyJson } = useCopyToClipboard(jsonUrl, "JSON URL");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className="size-9 sm:size-8"
					aria-label="More options"
					title="More options"
				>
					<MoreHorizontal className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuItem onClick={copyMd}>
					<FileText className="size-3.5" />
					Copy Markdown URL
				</DropdownMenuItem>
				<DropdownMenuItem onClick={copyJson}>
					<FileJson className="size-3.5" />
					Copy JSON URL
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function useCopyToClipboard(url: string, label: string) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		},
		[],
	);

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => setCopied(false), 1500);
			toast.success(`${label} copied`);
		} catch (e) {
			toast.error(errorMessage(e));
		}
	}

	return { copied, copy };
}
