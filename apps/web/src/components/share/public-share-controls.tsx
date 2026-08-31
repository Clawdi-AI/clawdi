"use client";

import { Check, FileJson, FileText, Link2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

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
	const { copied, copy } = useCopyToClipboard({ success: "Link copied" });
	return (
		<Button
			variant="outline"
			size="icon"
			// 36px on mobile (matches Button's default `size="icon"`), 32px
			// at `sm:` and up — denser desktop cluster, thumb-safe phone.
			className={cn("size-9 sm:size-8", copied && "text-success")}
			onClick={() => copy(url)}
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
	const { copy: copyMd } = useCopyToClipboard({
		success: "Markdown URL copied",
	});
	const { copy: copyJson } = useCopyToClipboard({ success: "JSON URL copied" });
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="outline"
						size="icon"
						className="size-9 sm:size-8"
						aria-label="More options"
						title="More options"
					/>
				}
			>
				<MoreHorizontal className="size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={() => copyMd(mdUrl)}>
						<FileText className="size-3.5" />
						Copy Markdown URL
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => copyJson(jsonUrl)}>
						<FileJson className="size-3.5" />
						Copy JSON URL
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
