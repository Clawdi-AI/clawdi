"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Brain, Laptop, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailMeta, DetailNotFound, DetailTitle } from "@/components/detail/layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

export default function MemoryDetailPage() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const api = useApi();

	const {
		data: memory,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["memory", id],
		queryFn: async () =>
			unwrap(await api.GET("/api/memories/{memory_id}", { params: { path: { memory_id: id } } })),
	});

	// First sentence (or 80 chars) — keeps the breadcrumb readable.
	const memoryTitle = memory?.content
		? memory.content.split(/[.\n]/)[0]?.slice(0, 80)?.trim() || null
		: null;
	useSetBreadcrumbTitle(memoryTitle);

	const deleteMemory = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/api/memories/{memory_id}", {
					params: { path: { memory_id: id } },
				}),
			),
		onSuccess: () => {
			toast.success("Memory deleted — your AI won't recall this on any agent.");
			router.push("/memories");
		},
		onError: (e) => toast.error("Failed to delete", { description: errorMessage(e) }),
	});

	const onDelete = () => {
		// Memory deletion is account-wide and reflects on every
		// machine via the daemon's live sync — the AI loses this
		// fact everywhere at once, and there's no undo from this page.
		const ok = window.confirm(
			"Delete this memory?\n\n" +
				"Your AI will stop recalling it across every agent within seconds. " +
				"You can always tell it the same thing again later.",
		);
		if (ok) deleteMemory.mutate();
	};

	return (
		<div className="space-y-5 px-4 lg:px-6">
			{error ? (
				<DetailNotFound title="Memory not found" message={errorMessage(error)} />
			) : isLoading ? (
				<div className="space-y-4 py-2">
					<Skeleton className="h-5 w-24" />
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-4 w-48" />
				</div>
			) : memory ? (
				<>
					<div className="space-y-2">
						<div className="flex items-start justify-between gap-3">
							<DetailTitle className="whitespace-pre-wrap leading-snug">
								{memory.content}
							</DetailTitle>
							<Button
								variant="outline"
								size="sm"
								onClick={onDelete}
								disabled={deleteMemory.isPending}
								className="shrink-0 text-destructive hover:text-destructive"
							>
								<Trash2 />
								Delete
							</Button>
						</div>
						<DetailMeta>
							<Badge
								variant="secondary"
								className={cn("h-5", MEMORY_CATEGORY_COLORS[memory.category])}
							>
								{memory.category}
							</Badge>
							<span>{memory.source}</span>
							{memory.created_at ? (
								<>
									<span>·</span>
									<span title={new Date(memory.created_at).toLocaleString()}>
										{relativeTime(memory.created_at)}
									</span>
								</>
							) : null}
						</DetailMeta>
					</div>

					{memory.tags?.length ? (
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="text-xs text-muted-foreground">Tags:</span>
							{memory.tags.map((t) => (
								<Badge key={t} variant="outline" className="font-normal">
									#{t}
								</Badge>
							))}
						</div>
					) : null}

					{memory.source_session_id ? (
						<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
							<Laptop className="size-3" />
							<span>
								{memory.source_machine_name
									? `Learned on ${memory.source_machine_name}`
									: "Learned from a session"}
								{" · "}
							</span>
							<Link
								href={`/sessions/${memory.source_session_id}`}
								className="underline hover:text-foreground"
							>
								view session
							</Link>
						</div>
					) : null}
				</>
			) : (
				<Alert>
					<Brain />
					<AlertTitle>Nothing to show</AlertTitle>
					<AlertDescription>This memory doesn't exist.</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
