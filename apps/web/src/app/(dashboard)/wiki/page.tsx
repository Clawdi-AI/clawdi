"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — match backend WikiPageSummary / PageList
// ---------------------------------------------------------------------------

type WikiPageSummary = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  source_count: number;
  stale: boolean;
  last_synthesis_at: string | null;
  updated_at: string;
};

type PageList = {
  items: WikiPageSummary[];
  total: number;
  page: number;
  page_size: number;
};

const KIND_FILTERS = [
  { value: "", label: "All" },
  { value: "entity", label: "Entities" },
  { value: "concept", label: "Concepts" },
  { value: "synthesis", label: "Syntheses" },
] as const;

const KIND_COLORS: Record<string, string> = {
  entity: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  concept: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
  synthesis: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

export default function WikiIndexPage() {
  const { getToken } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [kind, setKind] = useState<string>("");
  const deferredQuery = useDeferredValue(searchQuery);

  const { data, isLoading, isFetching } = useQuery<PageList>({
    queryKey: ["wiki", "pages", { kind }],
    queryFn: async () => {
      const token = await getToken();
      const params = new URLSearchParams({ page_size: "200" });
      if (kind) params.set("kind", kind);
      return apiFetch<PageList>(
        `/api/wiki/pages?${params.toString()}`,
        token!,
      );
    },
  });

  // Client-side filter on title/slug — server-side text search comes after
  // the synthesis pipeline lands and we can index compiled_truth.
  const filtered = (data?.items ?? []).filter((p) => {
    if (!deferredQuery) return true;
    const q = deferredQuery.toLowerCase();
    return p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <BookOpen className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Wiki</h1>
          {data && (
            <span className="text-sm text-muted-foreground ml-2">
              {data.total} {data.total === 1 ? "page" : "pages"}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground max-w-prose">
          Synthesized knowledge across your memory, skills, sessions, and
          vault. Pages are auto-generated as your data grows; each one
          aggregates everything we know about one entity, project, or
          concept.
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by title or slug…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setKind(f.value)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                kind === f.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {isFetching && !isLoading && (
          <Loader2 className="size-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState query={deferredQuery} hasAny={(data?.total ?? 0) > 0} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((page) => (
            <li key={page.id}>
              <Link
                href={`/wiki/${page.slug}`}
                className="block group rounded-lg border bg-card hover:border-foreground/20 hover:bg-accent/30 transition-colors"
              >
                <div className="p-4 flex items-start gap-4">
                  <div className="size-10 rounded-lg bg-muted/50 flex items-center justify-center text-muted-foreground shrink-0">
                    <FileText className="size-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium group-hover:underline">
                        {page.title}
                      </h3>
                      <span
                        className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium",
                          KIND_COLORS[page.kind] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {page.kind}
                      </span>
                      {page.stale && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium bg-orange-500/10 text-orange-700 dark:text-orange-400">
                          Stale
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 font-mono">
                      {page.slug}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground text-right shrink-0 space-y-0.5">
                    <div>
                      {page.source_count} source
                      {page.source_count === 1 ? "" : "s"}
                    </div>
                    <div>{relativeTime(page.updated_at)}</div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ query, hasAny }: { query: string; hasAny: boolean }) {
  if (query) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <FileText className="size-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm">No pages matching &ldquo;{query}&rdquo;.</p>
      </div>
    );
  }
  if (hasAny) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <FileText className="size-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm">No pages match the current filter.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dashed bg-card/50 p-10 text-center">
      <BookOpen className="size-10 mx-auto mb-4 text-muted-foreground opacity-50" />
      <h3 className="font-medium">Your wiki is empty.</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
        As your synced memory and sessions grow, Clawdi will auto-generate
        wiki pages — one per real-world entity, project, or concept. Each
        page aggregates evidence across all four domains.
      </p>
      <p className="text-xs text-muted-foreground mt-4">
        The synthesis pipeline runs nightly. You&rsquo;ll see your first
        pages within 24 hours of your next push.
      </p>
    </div>
  );
}
