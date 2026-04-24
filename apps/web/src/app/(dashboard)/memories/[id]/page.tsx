"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, Brain, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { DetailHeader } from "@/components/detail-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

export default function MemoryDetailPage() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const { getToken } = useAuth();

	const {
		data: memory,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["memory", id],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<Memory>(`/api/memories/${id}`, token);
		},
	});

	const deleteMemory = useMutation({
		mutationFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/memories/${id}`, token, { method: "DELETE" });
		},
		onSuccess: () => {
			toast.success("Memory deleted");
			router.push("/memories");
		},
		onError: (e) => toast.error("Failed to delete", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<DetailHeader
				backHref="/memories"
				backLabel="Back to memories"
				actions={
					memory && !isLoading ? (
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
					) : null
				}
			/>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Memory not found</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : isLoading ? (
				<Card>
					<CardContent className="space-y-4 py-6">
						<Skeleton className="h-5 w-24" />
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-4 w-48" />
					</CardContent>
				</Card>
			) : memory ? (
				<>
					{/* Title treatment parallels Sessions/Skills detail: the content
					    IS the memory, so it becomes the h1; a subtitle row below
					    carries the meta (category / source / created). */}
					<div className="space-y-2">
						<h1 className="whitespace-pre-wrap font-semibold text-lg leading-snug tracking-tight">
							{memory.content}
						</h1>
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Badge variant="secondary" className={cn(MEMORY_CATEGORY_COLORS[memory.category])}>
								{memory.category}
							</Badge>
							<span className="text-muted-foreground">{memory.source}</span>
							{memory.created_at ? (
								<>
									<span className="text-muted-foreground">·</span>
									<span className="text-muted-foreground">{relativeTime(memory.created_at)}</span>
								</>
							) : null}
						</div>
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

					<Card>
						<CardContent className="py-4">
							<dl className="grid gap-3 text-sm sm:grid-cols-2">
								<div>
									<dt className="text-xs text-muted-foreground">Created</dt>
									<dd>{memory.created_at ? new Date(memory.created_at).toLocaleString() : "—"}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted-foreground">ID</dt>
									<dd className="font-mono text-xs">{memory.id}</dd>
								</div>
							</dl>
						</CardContent>
					</Card>
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
