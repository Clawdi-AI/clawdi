"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText, Tag, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailMeta, DetailNotFound, DetailStats, DetailTitle } from "@/components/detail/layout";
import { Markdown } from "@/components/markdown";
import { Stat } from "@/components/meta/stat";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { errorMessage, relativeTime } from "@/lib/utils";

// Strip the leading `---\n...\n---` YAML frontmatter so the markdown
// renderer doesn't show "name:" / "description:" lines (already
// rendered above as DetailTitle + description) and so the closing
// `---` doesn't render as a stray `<hr>` next to the Separator.
function stripFrontmatter(raw: string): string {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return m ? (m[1] ?? "") : raw;
}

export default function SkillDetailPage() {
	const { key } = useParams<{ key: string }>();
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();

	const {
		data: skill,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["skill", key],
		queryFn: async () =>
			unwrap(await api.GET("/api/skills/{skill_key}", { params: { path: { skill_key: key } } })),
	});

	useSetBreadcrumbTitle(skill?.name || (skill ? key : null));

	const uninstall = useMutation({
		mutationFn: async () =>
			unwrap(await api.DELETE("/api/skills/{skill_key}", { params: { path: { skill_key: key } } })),
		onSuccess: () => {
			toast.success("Skill uninstalled");
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			router.push("/skills");
		},
		onError: (e) => toast.error("Failed to uninstall", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			{error ? (
				<DetailNotFound title="Skill not found" message={errorMessage(error)} />
			) : isLoading ? (
				<div className="space-y-3 py-2">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-64" />
				</div>
			) : skill ? (
				<>
					<div className="space-y-2">
						<div className="flex items-start justify-between gap-3">
							<DetailTitle className="truncate">{skill.name}</DetailTitle>
							<Button
								variant="outline"
								size="sm"
								onClick={() => uninstall.mutate()}
								disabled={uninstall.isPending}
								className="shrink-0 text-destructive hover:text-destructive"
							>
								<Trash2 />
								Uninstall
							</Button>
						</div>
						<DetailMeta>
							<span>{skill.source}</span>
							{skill.source_repo ? (
								<>
									<span>·</span>
									<a
										href={`https://github.com/${skill.source_repo}`}
										target="_blank"
										rel="noreferrer"
										className="inline-flex items-center gap-1 hover:text-foreground"
									>
										{skill.source_repo}
										<ExternalLink className="size-3" />
									</a>
								</>
							) : null}
							{skill.created_at ? (
								<>
									<span>·</span>
									<span>installed {relativeTime(skill.created_at)}</span>
								</>
							) : null}
						</DetailMeta>
					</div>

					<DetailStats>
						<Stat icon={Tag} label={`v${skill.version}`} />
						<Stat
							icon={FileText}
							label={`${skill.file_count} file${skill.file_count === 1 ? "" : "s"}`}
						/>
					</DetailStats>

					{skill.description ? (
						<p className="text-sm text-muted-foreground">{skill.description}</p>
					) : null}

					{skill.content ? (
						<>
							<Separator />
							<div className="prose prose-sm max-w-none dark:prose-invert">
								<Markdown content={stripFrontmatter(skill.content)} />
							</div>
						</>
					) : null}
				</>
			) : null}
		</div>
	);
}
