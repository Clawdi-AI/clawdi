"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
	Brain,
	CalendarClock,
	GitBranch,
	History,
	Laptop,
	Link2,
	Tags,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	DetailMeta,
	DetailNotFound,
	DetailPanel,
	DetailStats,
	DetailTitle,
} from "@/components/detail/layout";
import { MemoryRelationshipList } from "@/components/memories/memory-relationship-list";
import { Stat } from "@/components/meta/stat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import type { Memory } from "@/lib/api-schemas";
import {
	MEMORY_CATEGORY_COLORS,
	MEMORY_CATEGORY_EMOJI,
	MEMORY_CATEGORY_TILE_CLASSES,
	MEMORY_FALLBACK_EMOJI,
} from "@/lib/memory-utils";
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

	const memoryTitle = memory?.content
		? memory.content.split(/[.\n]/)[0]?.slice(0, 80)?.trim() || null
		: null;
	const detailTitle = memoryTitle || "Memory";
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
						{/* Category emoji tile — the same identity treatment every
						    other object card/detail header gets (vivid art direction). */}
						<div className="flex min-w-0 flex-1 items-start gap-3">
							<span
								aria-hidden
								className={cn(
									"flex size-11 shrink-0 select-none items-center justify-center rounded-xl text-2xl leading-none",
									MEMORY_CATEGORY_TILE_CLASSES[memory.category] ?? "bg-muted",
								)}
							>
								{MEMORY_CATEGORY_EMOJI[memory.category] ?? MEMORY_FALLBACK_EMOJI}
							</span>
							<div className="min-w-0 flex-1 space-y-2">
								<div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
									<Brain className="size-3.5" />
									<span>Memory</span>
								</div>
								<DetailTitle className="break-words">{detailTitle}</DetailTitle>
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
									<span>·</span>
									<span className="tabular-nums">
										{(memory.access_count ?? 0) > 0
											? `Recalled ${memory.access_count} ${memory.access_count === 1 ? "time" : "times"}`
											: "Never recalled yet"}
									</span>
								</DetailMeta>
								{memory.source_machine_name || memory.source_session_id || memory.xtrace?.status ? (
									<DetailStats>
										{memory.source_machine_name ? (
											<Stat icon={Laptop} label={memory.source_machine_name} />
										) : null}
										{memory.source_session_id ? (
											<Stat
												icon={Link2}
												label={`Session ${shortId(memory.source_session_id)}`}
												title={memory.source_session_id}
											/>
										) : null}
										{memory.xtrace?.status ? (
											<Stat icon={GitBranch} label={`XTrace ${memory.xtrace.status}`} />
										) : null}
									</DetailStats>
								) : null}
							</div>
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

					<DetailPanel className="space-y-3">
						<SectionHeader icon={Brain} title="Content" />
						<p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
							{memory.content}
						</p>
					</DetailPanel>

					<DetailPanel className="space-y-4">
						<SectionHeader icon={Link2} title="Source" />
						<div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
							<MetadataItem label="Source" value={memory.source} />
							<MetadataItem label="Agent" value={memory.source_machine_name} />
							<MetadataItem
								label="Session"
								value={memory.source_session_id}
								href={
									memory.source_session_id ? sessionDetailHref(memory.source_session_id) : undefined
								}
								valueTitle={memory.source_session_id}
								compact
								mono
							/>
							<MetadataItem
								label="Environment"
								value={memory.source_environment_id}
								valueTitle={memory.source_environment_id}
								compact
								mono
							/>
						</div>

						<div className="flex flex-wrap items-center gap-1.5">
							<Tags className="size-3.5 text-muted-foreground" />
							{memory.tags?.length ? (
								memory.tags.map((tag) => (
									<Badge key={tag} variant="outline" className="h-5 font-normal">
										#{tag}
									</Badge>
								))
							) : (
								<span className="text-xs text-muted-foreground">No tags</span>
							)}
						</div>

						{memory.source_session_id ? (
							<Button variant="outline" size="sm" className="w-fit" asChild>
								<Link href={sessionDetailHref(memory.source_session_id)}>
									<Link2 />
									View session
								</Link>
							</Button>
						) : null}
					</DetailPanel>

					{memory.xtrace ? <XTraceMemoryDetails xtrace={memory.xtrace} /> : null}

					{memory.source_session_id ? (
						<section className="space-y-3">
							<div className="flex items-center justify-between gap-3">
								<SectionHeader icon={History} title="Same Session" />
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
						</section>
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

function SectionHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
	return (
		<div className="flex items-center gap-2 text-sm font-semibold">
			<Icon className="size-4 text-muted-foreground" />
			<h2>{title}</h2>
		</div>
	);
}

function MetadataItem({
	label,
	value,
	href,
	valueTitle,
	compact = false,
	mono = false,
}: {
	label: string;
	value?: string | null;
	href?: string;
	valueTitle?: string | null;
	compact?: boolean;
	mono?: boolean;
}) {
	if (!value) return null;
	const displayValue = compact && shouldShorten(value) ? shortId(value) : value;
	const valueClassName = cn("break-words text-foreground", mono ? "font-mono text-xs" : "text-sm");

	return (
		<div className="min-w-0 space-y-1">
			<div className="text-xs font-medium text-muted-foreground">{label}</div>
			{href ? (
				<Link
					href={href}
					title={valueTitle ?? value}
					className={cn(valueClassName, "underline-offset-4 hover:underline")}
				>
					{displayValue}
				</Link>
			) : (
				<div title={valueTitle ?? value} className={valueClassName}>
					{displayValue}
				</div>
			)}
		</div>
	);
}

function XTraceMemoryDetails({ xtrace }: { xtrace: NonNullable<Memory["xtrace"]> }) {
	const timeline = xtrace.timeline ?? [];
	return (
		<DetailPanel className="space-y-4">
			<SectionHeader icon={GitBranch} title="XTrace" />
			<div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
				<MetadataItem label="Type" value={xtrace.type} />
				<MetadataItem label="Status" value={xtrace.status} />
				<MetadataItem label="Operation" value={xtrace.operation} />
				<MetadataItem label="Source" value={xtrace.source_type} />
				<MetadataItem
					label="Supersedes"
					value={xtrace.supersedes?.map((id) => shortId(id)).join(", ")}
					valueTitle={xtrace.supersedes?.join(", ")}
					mono
				/>
				<MetadataItem
					label="Superseded by"
					value={xtrace.superseded_by}
					valueTitle={xtrace.superseded_by}
					compact
					mono
				/>
			</div>
			{xtrace.memory_id ? (
				<MetadataItem
					label="XTrace ID"
					value={xtrace.memory_id}
					valueTitle={xtrace.memory_id}
					compact
					mono
				/>
			) : null}
			{timeline.length ? (
				<div className="space-y-2">
					<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<CalendarClock className="size-3.5" />
						<span>Timeline</span>
					</div>
					<div className="divide-y border-y">
						{timeline.map((item, index) => (
							<div key={`${item.memory_id ?? index}-${index}`} className="flex gap-3 py-3">
								<Badge variant="outline" className="h-5 shrink-0 uppercase">
									{item.operation ?? "event"}
								</Badge>
								<div className="min-w-0 space-y-1">
									<p className="line-clamp-3 break-words text-sm leading-relaxed">{item.content}</p>
									<div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
										{item.status ? <span>{item.status}</span> : null}
										{item.status && item.at ? <span>·</span> : null}
										{item.at ? (
											<span title={new Date(item.at).toLocaleString()}>
												{relativeTime(item.at)}
											</span>
										) : null}
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</DetailPanel>
	);
}

function shouldShorten(value: string) {
	return value.length > 28 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function shortId(value: string) {
	if (value.length <= 16) return value;
	return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
