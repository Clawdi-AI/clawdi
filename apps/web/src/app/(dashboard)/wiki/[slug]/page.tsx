"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  Clock,
  FileText,
  Key,
  Link2,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — match backend WikiPageDetail
// ---------------------------------------------------------------------------

type WikiLinkOut = {
  id: string;
  link_type: string;
  confidence: number | null;
  to_page_id: string | null;
  to_page_slug: string | null;
  to_page_title: string | null;
  source_type: string | null;
  source_ref: string | null;
};

type WikiPageDetail = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  compiled_truth: string | null;
  frontmatter: Record<string, unknown> | null;
  source_count: number;
  stale: boolean;
  last_synthesis_at: string | null;
  created_at: string;
  updated_at: string;
  outgoing_links: WikiLinkOut[];
  backlinks: WikiLinkOut[];
};

const SOURCE_ICONS: Record<string, typeof Brain> = {
  memory: Brain,
  skill: Sparkles,
  session: FileText,
  vault: Key,
};

const SOURCE_COLORS: Record<string, string> = {
  memory: "text-blue-600 dark:text-blue-400",
  skill: "text-purple-600 dark:text-purple-400",
  session: "text-green-600 dark:text-green-400",
  vault: "text-amber-600 dark:text-amber-400",
};

export default function WikiPageView() {
  const { getToken } = useAuth();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const { data, isLoading, error } = useQuery<WikiPageDetail>({
    queryKey: ["wiki", "page", slug],
    queryFn: async () => {
      const token = await getToken();
      return apiFetch<WikiPageDetail>(
        `/api/wiki/pages/${encodeURIComponent(slug!)}`,
        token!,
      );
    },
    enabled: !!slug,
    retry: (count, err: Error) =>
      // Don't retry 404s — they're expected when a slug doesn't exist.
      !err.message.includes("404") && count < 2,
  });

  if (error?.message.includes("404")) {
    notFound();
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        href="/wiki"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to wiki
      </Link>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : data ? (
        <PageContent page={data} />
      ) : null}
    </div>
  );
}

function PageContent({ page }: { page: WikiPageDetail }) {
  // Group outgoing links by whether they point to another page (graph
  // edges) or to a source item (memory/skill/session/vault evidence).
  const outgoingPageLinks = page.outgoing_links.filter((l) => l.to_page_id);
  const sourceLinks = page.outgoing_links.filter((l) => l.source_type);

  // Group source links by domain so the panel reads like a clean ledger.
  const sourcesByDomain = sourceLinks.reduce<Record<string, WikiLinkOut[]>>(
    (acc, l) => {
      const k = l.source_type!;
      (acc[k] = acc[k] ?? []).push(l);
      return acc;
    },
    {},
  );

  return (
    <article className="space-y-8">
      <header className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-semibold">{page.title}</h1>
          <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium bg-muted text-muted-foreground">
            {page.kind}
          </span>
          {page.stale && (
            <span className="text-[10px] px-2 py-0.5 rounded uppercase tracking-wide font-medium bg-orange-500/10 text-orange-700 dark:text-orange-400 inline-flex items-center gap-1">
              <AlertTriangle className="size-3" />
              Stale
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
          <span>{page.slug}</span>
          <span>·</span>
          <span>
            {page.source_count} source
            {page.source_count === 1 ? "" : "s"}
          </span>
          {page.last_synthesis_at && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                synthesized {relativeTime(page.last_synthesis_at)}
              </span>
            </>
          )}
        </div>
      </header>

      {/* Compiled truth */}
      <section className="rounded-xl border bg-card p-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Compiled truth
        </h2>
        {page.compiled_truth ? (
          <p className="text-base leading-relaxed whitespace-pre-wrap">
            {page.compiled_truth}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            No synthesis yet — the synthesis pipeline runs after at least
            one source links to this page.
          </p>
        )}
      </section>

      {/* Sources panel */}
      {sourceLinks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sources
          </h2>
          <div className="space-y-4">
            {Object.entries(sourcesByDomain).map(([domain, links]) => {
              const Icon = SOURCE_ICONS[domain] ?? FileText;
              const color = SOURCE_COLORS[domain] ?? "text-muted-foreground";
              return (
                <div key={domain} className="space-y-1.5">
                  <div className={cn("text-xs font-medium inline-flex items-center gap-1.5", color)}>
                    <Icon className="size-3.5" />
                    {domain} ({links.length})
                  </div>
                  <ul className="space-y-1 pl-5">
                    {links.map((l) => (
                      <li
                        key={l.id}
                        className="text-sm font-mono text-muted-foreground"
                      >
                        {l.source_ref}
                        {l.confidence != null && (
                          <span className="ml-2 text-[10px] opacity-60">
                            ({Math.round(l.confidence * 100)}%)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Related pages (outgoing graph edges) */}
      {outgoingPageLinks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1.5">
            <Link2 className="size-3.5" />
            Related pages
          </h2>
          <ul className="space-y-1">
            {outgoingPageLinks.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/wiki/${l.to_page_slug}`}
                  className="text-sm hover:underline inline-flex items-center gap-2"
                >
                  <span>{l.to_page_title}</span>
                  <span className="text-xs text-muted-foreground">
                    ({l.link_type})
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Backlinks */}
      {page.backlinks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Linked from
          </h2>
          <ul className="space-y-1">
            {page.backlinks.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/wiki/${l.to_page_slug}`}
                  className="text-sm hover:underline inline-flex items-center gap-2"
                >
                  <span>← {l.to_page_title}</span>
                  <span className="text-xs text-muted-foreground">
                    ({l.link_type})
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
