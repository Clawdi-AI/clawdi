"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Brain, GitBranch, Laptop, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailMeta, DetailNotFound, DetailPanel, DetailTitle } from "@/components/detail/layout";
import { MemoryRelationshipList } from "@/components/memories/memory-relationship-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { projectResourceHref, sessionDetailHref } from "@/lib/project-resource-model";
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

	const { data: relatedMemories, isLoading: relatedMemoriesLoading } = useQuery({
		queryKey: ["memories", "session", memory?.source_session_id],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/memories", {
					params: {
						query: {
							source_session_id: memory?.source_session_id ?? "",
							page_size: 10,
						},
					},
				}),
			),
		enabled: !!memory?.source_session_id,
	});

	// First sentence (or 80 chars) — keeps the breadcrumb readable.
	const memoryTitle = memory?.content
		? memory.content.split(/[.\n]/)[0]?.slice(0, 80)?.trim() || null
		: null;
	const siblingMemories = (relatedMemories?.items ?? []).filter((item) => item.id !== memory?.id);
	useSetBreadcrumbTitle(memoryTitle);

	const deleteMemory = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/api/memories/{memory_id}", {
					params: { path: { memory_id: id } },
				}),
			),
		onSuccess: () => {
			toast.success("Memory Deleted", {
				description: "Your agents will no longer recall it.",
			});
			router.push(projectResourceHref("memories"));
		},
		onError: (e) => toast.error("Couldn't delete memory", { description: errorMessage(e) }),
	});

	const onDelete = () => deleteMemory.mutate();

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
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0 flex-1 space-y-2">
							<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Brain className="size-3.5" />
								<span>Memory</span>
							</div>
							<DetailTitle>Memory</DetailTitle>
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
											Saved {relativeTime(memory.created_at)}
										</span>
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

					<DetailPanel>
						<p className="whitespace-pre-wrap break-words text-base leading-relaxed">
							{memory.content}
						</p>
					</DetailPanel>

					<DetailPanel className="space-y-4">
						<div className="space-y-1">
							<h2 className="text-sm font-semibold">Source relationship</h2>
							<p className="text-xs text-muted-foreground">
								This memory is account-level context. Its source tells you which agent/session
								taught it to Clawdi.
							</p>
						</div>
						<div className="grid gap-2 text-sm sm:grid-cols-2">
							<DetailField label="source" value={memory.source} />
							<DetailField label="agent" value={memory.source_machine_name} />
							<DetailField label="session" value={memory.source_session_id} />
							<DetailField label="environment" value={memory.source_environment_id} />
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
											href={sessionDetailHref(memory.source_session_id)}
											className="underline hover:text-foreground"
										>
											View session
										</Link>
									</>
								) : null}
							</div>
						) : null}

						{memory.source_session_id ? (
							<div className="space-y-3 border-t pt-4">
								<div className="flex items-center justify-between gap-3">
									<h2 className="text-sm font-semibold">Learned in the same session</h2>
									{siblingMemories.length ? (
										<span className="text-xs tabular-nums text-muted-foreground">
											{siblingMemories.length}
										</span>
									) : null}
								</div>
								<MemoryRelationshipList
									memories={siblingMemories}
									isLoading={relatedMemoriesLoading}
									emptyMessage="No other memories are linked to this source session."
									limit={5}
								/>
							</div>
						) : null}

						{memory.xtrace ? <XTraceMemoryDetails xtrace={memory.xtrace} /> : null}
					</DetailPanel>
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

function DetailField({ label, value }: { label: string; value?: string | null }) {
	if (!value) return null;
	return (
		<div className="min-w-0">
			<span className="text-muted-foreground">{label}: </span>
			<span className="break-words font-mono text-xs">{value}</span>
		</div>
	);
}

function XTraceMemoryDetails({ xtrace }: { xtrace: NonNullable<Memory["xtrace"]> }) {
	const timeline = xtrace.timeline ?? [];
	return (
		<div className="space-y-3 border-t pt-4">
			<div className="flex items-center gap-2">
				<GitBranch className="size-4 text-muted-foreground" />
				<h2 className="text-sm font-semibold">XTrace details</h2>
			</div>
			<div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
				<XTraceField label="type" value={xtrace.type} />
				<XTraceField label="status" value={xtrace.status} />
				<XTraceField label="operation" value={xtrace.operation} />
				<XTraceField label="source" value={xtrace.source_type} />
				<XTraceField label="supersedes" value={xtrace.supersedes?.join(", ")} />
				<XTraceField label="superseded by" value={xtrace.superseded_by} />
			</div>
			{xtrace.memory_id ? (
				<div className="break-all rounded-md bg-muted px-2.5 py-2 font-mono text-xs text-muted-foreground">
					{xtrace.memory_id}
				</div>
			) : null}
			{timeline.length ? (
				<div className="space-y-2">
					<h3 className="text-xs font-medium text-muted-foreground">Versioning timeline</h3>
					<div className="space-y-2">
						{timeline.map((item, index) => (
							<div key={`${item.memory_id ?? index}-${index}`} className="flex gap-3 text-sm">
								<Badge variant="outline" className="h-fit shrink-0 uppercase">
									{item.operation}
								</Badge>
								<div className="min-w-0 space-y-1">
									<p className="break-words leading-relaxed">{item.content}</p>
									<div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
										{item.status ? <span>{item.status}</span> : null}
										{item.at ? <span>{new Date(item.at).toLocaleString()}</span> : null}
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

function XTraceField({ label, value }: { label: string; value?: string | null }) {
	if (!value) return null;
	return (
		<div className="min-w-0">
			<span className="text-muted-foreground">{label}: </span>
			<span className="break-words font-mono text-xs">{value}</span>
		</div>
	);
}
