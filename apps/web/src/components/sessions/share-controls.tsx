"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Link2, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

/**
 * Owner-side share controls — Notion-style cluster:
 *
 *   [Share ▾]  [🔗]
 *
 * The Share button opens an inline popover with the visibility toggle
 * and per-format URLs. The chain-link icon next to it copies the
 * canonical URL directly — `/s/{session_id}` exists permanently per
 * Notion / Drive convention, so the icon needs zero backend interaction
 * to do its job.
 *
 * Sessions default to Private. Toggling "Public Access" on creates a
 * `kind='link'` permission row; toggling off revokes it. Visiting the
 * URL when private requires sign-in (server-side gate, see
 * `/s/[id]/page.tsx`).
 */
export function SessionShareControls({
	sessionId,
	isShared,
}: {
	sessionId: string;
	isShared: boolean;
}) {
	return (
		<div className="flex items-center gap-1">
			<SharePopover sessionId={sessionId} isShared={isShared} />
			<CopyLinkButton sessionId={sessionId} />
		</div>
	);
}

function buildShareUrl(sessionId: string): string {
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	return `${origin}/s/${sessionId}`;
}

function SharePopover({ sessionId, isShared }: { sessionId: string; isShared: boolean }) {
	const api = useApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);

	// Fetch when popover opens OR when the parent already knows the
	// session has an active link permission (so the toggle reflects
	// state immediately on first open without a Loading flash).
	const permsQuery = useQuery({
		queryKey: ["session-permissions", sessionId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions/{session_id}/permissions", {
					params: { path: { session_id: sessionId } },
				}),
			),
		enabled: open || isShared,
	});

	const linkPermission = permsQuery.data?.permissions.find((p) => p.kind === "link") ?? null;
	const sharedNow = linkPermission !== null;

	function invalidate() {
		qc.invalidateQueries({ queryKey: ["session-permissions", sessionId] });
		qc.invalidateQueries({ queryKey: ["session", sessionId] });
		qc.invalidateQueries({ queryKey: ["sessions"] });
	}

	const enableMutation = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/api/sessions/{session_id}/permissions", {
					params: { path: { session_id: sessionId } },
					body: { kind: "link" },
				}),
			),
		onSuccess: () => {
			invalidate();
			toast.success("Public Access Enabled");
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const disableMutation = useMutation({
		mutationFn: async () => {
			const res = await api.DELETE("/api/sessions/{session_id}/permissions", {
				params: { path: { session_id: sessionId }, query: { kind: "link" } },
			});
			if (res.error !== undefined) {
				throw new ApiError(res.response.status, JSON.stringify(res.error));
			}
		},
		onSuccess: () => {
			invalidate();
			toast.success("Public Access Disabled");
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const pending = enableMutation.isPending || disableMutation.isPending;

	function onToggle(next: boolean) {
		if (next) enableMutation.mutate();
		else disableMutation.mutate();
	}

	const url = buildShareUrl(sessionId);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5">
					<Share2
						className={cn("size-3.5", sharedNow ? "text-success" : "text-muted-foreground")}
					/>
					Share
					<ChevronDown className="size-3 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-0">
				<div className="flex items-start justify-between gap-3 px-3 py-3">
					<div className="min-w-0 flex-1 space-y-0.5">
						<Label htmlFor="share-toggle" className="text-sm font-medium">
							Public Access
						</Label>
						<p className="text-xs text-muted-foreground">
							{sharedNow
								? "Anyone with the link can view this session."
								: "Only you can view this session."}
						</p>
					</div>
					<Switch
						id="share-toggle"
						checked={sharedNow}
						disabled={pending}
						onCheckedChange={onToggle}
					/>
				</div>

				{/* URL row is always shown — the URL exists regardless of
				    public-access state. Copying it for personal reference
				    is fine even when the link won't work for anyone else. */}
				<div className="space-y-3 border-t px-3 py-3">
					<PrimaryCopy url={url} />
					{sharedNow ? (
						<div className="space-y-1.5">
							<div className="text-xs text-muted-foreground">Agent Formats</div>
							<div className="flex gap-2">
								<SecondaryCopy url={`${url}.md`} label="Markdown" />
								<SecondaryCopy url={`${url}.json`} label="JSON" />
							</div>
						</div>
					) : null}
				</div>

				{linkPermission ? (
					<div className="border-t px-3 py-2">
						<div className="text-xs text-muted-foreground">
							Shared {relativeTime(linkPermission.created_at)}
						</div>
					</div>
				) : null}

				{permsQuery.isLoading && open && !linkPermission ? (
					<div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
						<Spinner className="size-3" /> Loading…
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

function CopyLinkButton({ sessionId }: { sessionId: string }) {
	const url = buildShareUrl(sessionId);
	const { copied, copy } = useCopyToClipboard(url, "Link");
	return (
		<Button
			variant="outline"
			size="icon"
			className={cn("size-8", copied && "text-success")}
			onClick={copy}
			aria-label="Copy Share Link"
			title="Copy share link"
		>
			{copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
		</Button>
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
			toast.success(`${label} Copied`);
		} catch (e) {
			toast.error(errorMessage(e));
		}
	}

	return { copied, copy };
}

function PrimaryCopy({ url }: { url: string }) {
	const { copied, copy } = useCopyToClipboard(url, "Link");
	return (
		<div className="flex items-center gap-2">
			<Input
				readOnly
				value={url}
				name="session-share-url"
				aria-label="Session share URL"
				autoComplete="off"
				spellCheck={false}
				className="h-8 font-mono text-xs"
				onFocus={(e) => e.currentTarget.select()}
			/>
			<Button
				variant="outline"
				size="sm"
				className={cn("h-8 shrink-0 gap-1.5", copied && "text-success")}
				onClick={copy}
			>
				{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
				Copy
			</Button>
		</div>
	);
}

function SecondaryCopy({ url, label }: { url: string; label: string }) {
	const { copied, copy } = useCopyToClipboard(url, label);
	return (
		<Button
			variant="outline"
			size="sm"
			className={cn("h-7 flex-1 gap-1.5 text-xs", copied && "text-success")}
			onClick={copy}
		>
			{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			{label}
		</Button>
	);
}
