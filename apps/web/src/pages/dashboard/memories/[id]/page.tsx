"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { Brain, Laptop, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailMeta, DetailNotFound, DetailPanel, DetailTitle } from "@/components/detail/layout";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { TimeTooltip } from "@/components/time-tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	LIBRARY_RESOURCE_SCOPE,
	type ResourceNavigationScope,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

export default function MemoryDetailPage({
	memoryId,
	scope = LIBRARY_RESOURCE_SCOPE,
}: {
	memoryId: string;
	scope?: ResourceNavigationScope;
}) {
	const router = useRouter();
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const collectionTarget = resourceCollectionTarget(scope, "memories");

	const {
		data: memory,
		isLoading,
		error,
		refetch,
	} = api.useQuery("get", "/v1/memories/{memory_id}", {
		params: { path: { memory_id: memoryId } },
	});

	// First sentence (or 80 chars) — keeps the breadcrumb readable.
	const memoryTitle = memory?.content
		? memory.content.split(/[.\n]/)[0]?.slice(0, 80)?.trim() || null
		: null;
	useSetBreadcrumbTitle(memoryTitle);
	const blockingError =
		isApiNotFoundError(error) || shouldBlockQueryError(error, memory) ? error : null;

	const deleteMemory = api.useMutation("delete", "/v1/memories/{memory_id}", {
		onSuccess: () => {
			toast.success("Memory deleted", {
				description: "Your agents will no longer recall it.",
			});
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/memories"] });
			void router.navigate({ href: collectionTarget.href });
		},
		onError: (e) => toast.error("Couldn't delete memory", { description: errorMessage(e) }),
	});

	const onDelete = () => deleteMemory.mutate({ params: { path: { memory_id: memoryId } } });

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<DetailBackLink href={collectionTarget.href} label={collectionTarget.label} />
			{scope.kind === "agent" ? (
				<Alert>
					<Brain />
					<AlertTitle>Shared across all agents</AlertTitle>
					<AlertDescription>
						This memory belongs to the account. Changes here affect all agents.
					</AlertDescription>
				</Alert>
			) : null}
			{blockingError && isApiNotFoundError(blockingError) ? (
				<DetailNotFound title="Memory not found" message={errorMessage(blockingError)} />
			) : blockingError ? (
				<ApiErrorPanel
					error={blockingError}
					onRetry={() => {
						void refetch();
					}}
					title="Couldn't load memory"
				/>
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
									<p>All agents will stop recalling it within seconds.</p>
									<p>You can tell it the same thing again later.</p>
								</>
							}
							confirmLabel="Delete memory"
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
											{scope.kind === "agent" ? "View in session library" : "View session"}
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
