"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { Brain, Laptop, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailMeta, DetailNotFound, DetailPanel, DetailTitle } from "@/components/detail/layout";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { TimeTooltip } from "@/components/time-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { projectResourceHref } from "@/lib/project-resource-model";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

export default function MemoryDetailPage({ memoryId }: { memoryId: string }) {
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();

	const {
		data: memory,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["memory", memoryId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/memories/{memory_id}", {
					params: { path: { memory_id: memoryId } },
				}),
			),
	});

	// First sentence (or 80 chars) — keeps the breadcrumb readable.
	const memoryTitle = memory?.content
		? memory.content.split(/[.\n]/)[0]?.slice(0, 80)?.trim() || null
		: null;
	useSetBreadcrumbTitle(memoryTitle);

	const deleteMemory = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/memories/{memory_id}", {
					params: { path: { memory_id: memoryId } },
				}),
			),
		onSuccess: () => {
			toast.success("Memory Deleted", {
				description: "Your agents will no longer recall it.",
			});
			queryClient.invalidateQueries({ queryKey: ["memories"] });
			void router.navigate({ href: projectResourceHref("memories") });
		},
		onError: (e) => toast.error("Couldn't delete memory", { description: errorMessage(e) }),
	});

	const onDelete = () => deleteMemory.mutate();

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
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
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0 flex-1 space-y-2">
							<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Brain className="size-3.5" />
								<span>Memory</span>
							</div>
							<DetailTitle className="whitespace-pre-wrap leading-snug">
								{memory.content}
							</DetailTitle>
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
										<TimeTooltip value={memory.created_at}>
											<span>Saved {relativeTime(memory.created_at)}</span>
										</TimeTooltip>
									</>
								) : null}
								{/* Whether agents actually USE a memory is the
								    fact that decides keep-vs-delete — surface it. */}
								<span>·</span>
								<span className="tabular-nums">
									{(memory.access_count ?? 0) > 0
										? `Recalled ${memory.access_count} ${memory.access_count === 1 ? "time" : "times"}`
										: "Never recalled yet"}
								</span>
							</DetailMeta>
						</div>
						<ConfirmAction
							title="Delete this memory?"
							description={
								<>
									<p>Your AI will stop recalling it across every agent within seconds.</p>
									<p>You can tell it the same thing again later.</p>
								</>
							}
							confirmLabel="Delete Memory"
							destructive
							onConfirm={onDelete}
						>
							<Button
								variant="outline"
								size="sm"
								disabled={deleteMemory.isPending}
								className="w-fit shrink-0 text-destructive hover:text-destructive"
							>
								<Trash2 />
								Delete
							</Button>
						</ConfirmAction>
					</div>

					<DetailPanel className="space-y-4">
						<div className="space-y-1">
							<h2 className="text-sm font-semibold">Recall Scope</h2>
							<p className="text-xs text-muted-foreground">
								This is account-level context. Agents can recall it across runs; it is not shared
								through Projects.
							</p>
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
						) : (
							<p className="text-xs text-muted-foreground">No tags saved for this memory.</p>
						)}

						{/* Provenance renders whenever ANY of it is known — machine
						    name alone is still useful without a session link. */}
						{memory.source_session_id || memory.source_machine_name ? (
							<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
								<Laptop className="size-3" />
								<span>
									{memory.source_machine_name
										? `Learned on ${memory.source_machine_name}`
										: "Learned from a session"}
								</span>
								{memory.source_session_id ? (
									<>
										<span>·</span>
										<Link
											to="/sessions/$id"
											params={{ id: memory.source_session_id }}
											className="underline hover:text-foreground"
										>
											View session
										</Link>
									</>
								) : null}
							</div>
						) : null}
					</DetailPanel>
				</>
			) : (
				<DetailNotFound title="Memory not found" message="This memory doesn't exist." />
			)}
		</div>
	);
}
