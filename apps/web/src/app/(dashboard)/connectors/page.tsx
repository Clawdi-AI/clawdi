"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;

export default function ConnectorsPage() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query);

  const { data: connections } = useQuery({
    queryKey: ["connections"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/connectors", token);
    },
  });

  const { data: availableApps, isLoading } = useQuery({
    queryKey: ["available-apps"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/connectors/available", token);
    },
  });

  const connectApp = useMutation({
    mutationFn: async (appName: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const result = await apiFetch<{ connect_url: string }>(
        `/api/connectors/${appName}/connect`,
        token,
        { method: "POST", body: JSON.stringify({}) },
      );
      window.open(result.connect_url, "_blank");
    },
    onSuccess: () => {
      setTimeout(
        () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
        3000,
      );
    },
  });

  const disconnectApp = useMutation({
    mutationFn: async (connectionId: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>(`/api/connectors/${connectionId}`, token, {
        method: "DELETE",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  const connectedNames = useMemo(
    () => new Set(connections?.map((c: any) => c.app_name) ?? []),
    [connections],
  );

  const filtered = useMemo(() => {
    if (!availableApps) return [];
    let items = [...availableApps];
    if (deferredQuery) {
      const q = deferredQuery.toLowerCase();
      items = items.filter(
        (a) =>
          a.name?.toLowerCase().includes(q) ||
          a.display_name?.toLowerCase().includes(q) ||
          a.description?.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) => {
      const ac = connectedNames.has(a.name) ? 1 : 0;
      const bc = connectedNames.has(b.name) ? 1 : 0;
      return bc - ac;
    });
    return items;
  }, [availableApps, deferredQuery, connectedNames]);

  const prevQuery = useDeferredValue(deferredQuery);
  if (prevQuery !== deferredQuery && page !== 0) setPage(0);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Connectors</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connect apps and enable capabilities for your AI agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {availableApps && (
            <span className="bg-muted px-3 py-1 rounded-full text-xs font-medium">
              {availableApps.length} available
            </span>
          )}
          {(connections?.length ?? 0) > 0 && (
            <span className="bg-primary/10 px-3 py-1 rounded-full text-xs font-semibold text-primary">
              {connections!.length} active
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connectors..."
          className="w-full border border-input bg-background rounded-xl pl-9 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 size-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          Loading connectors...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {query
            ? `No connectors matching "${query}"`
            : "No connectors available. Configure COMPOSIO_API_KEY."}
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {paged.map((app: any, idx: number) => {
                const isConnected = connectedNames.has(app.name);
                const connection = connections?.find(
                  (c: any) => c.app_name === app.name,
                );
                const col = idx % 3;
                const row = Math.floor(idx / 3);
                return (
                  <div
                    key={app.name}
                    className={cn(
                      "group flex items-start gap-3 px-4 py-4 transition-colors hover:bg-accent/30",
                      col < 2 && "lg:border-r border-border",
                      row < Math.ceil(paged.length / 3) - 1 && "border-b border-border",
                    )}
                  >
                    {/* Logo */}
                    <div className="shrink-0 mt-0.5">
                      {app.logo ? (
                        <img
                          src={app.logo}
                          alt=""
                          className="size-8 rounded"
                          onError={(e) => {
                            const t = e.target as HTMLImageElement;
                            t.style.display = "none";
                            const fallback = document.createElement("div");
                            fallback.className =
                              "size-8 rounded bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground";
                            fallback.textContent =
                              app.display_name?.[0] ?? "?";
                            t.parentElement!.appendChild(fallback);
                          }}
                        />
                      ) : (
                        <div className="size-8 rounded bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground">
                          {app.display_name?.[0] ?? "?"}
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate">
                          {app.display_name}
                        </span>
                        {isConnected && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400 font-medium">
                            <Check className="size-2.5" />
                            Connected
                          </span>
                        )}
                      </div>
                      {app.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                          {app.description}
                        </p>
                      )}
                    </div>

                    {/* Action */}
                    <div className="shrink-0 pt-0.5">
                      {isConnected ? (
                        <button
                          type="button"
                          onClick={() =>
                            connection && disconnectApp.mutate(connection.id)
                          }
                          className="text-[11px] text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => connectApp.mutate(app.name)}
                          disabled={connectApp.isPending}
                          className="rounded-lg bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
                        >
                          Connect
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {page * PAGE_SIZE + 1}–
                {Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{" "}
                {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="size-8 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="px-3 text-xs text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                  disabled={page >= totalPages - 1}
                  className="size-8 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted disabled:opacity-30 transition-colors"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
