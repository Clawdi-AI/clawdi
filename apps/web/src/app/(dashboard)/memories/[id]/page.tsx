"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Brain, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailActions, DetailMeta, DetailNotFound, DetailTitle } from "@/components/detail/layout";
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
			toast.success("Memory deleted");
			router.push("/memories");
		},
		onError: (e) => toast.error("Failed to delete", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<DetailActions>
				{memory && !isLoading ? (
					<Button
						variant="outline"
						size="sm"
						onClick={() => deleteMemory.mutate()}
						disabled={deleteMemory.isPending}
						className="text-destructive hover:text-destructive"
					>
						<Trash2 />
						Delete
					</Button>
				) : null}
			</DetailActions>

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
						<DetailTitle className="whitespace-pre-wrap leading-snug">{memory.content}</DetailTitle>
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
