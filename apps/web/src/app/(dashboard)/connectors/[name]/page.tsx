"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Link2Off, Plug } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

export default function ConnectorDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { data: apps } = useQuery({
    queryKey: ["available-apps"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/connectors/available", token);
    },
  });

  const { data: connections } = useQuery({
    queryKey: ["connections"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/connectors", token);
    },
  });

  const connectApp = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const result = await apiFetch<{ connect_url: string }>(
        `/api/connectors/${name}/connect`,
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

  const app = apps?.find((a: any) => a.name === name);
  const activeConnections =
    connections?.filter((c: any) => c.app_name === name) ?? [];
  const isConnected = activeConnections.length > 0;

  return (
    <div className="max-w-2xl space-y-6">
      {/* Back */}
      <Link
        href="/connectors"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Connectors
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted">
          {app?.logo ? (
            <img src={app.logo} alt="" className="size-8 rounded" />
          ) : (
            <span className="text-2xl">
              {app?.display_name?.[0] ?? "?"}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">
              {app?.display_name ?? name}
            </h1>
            {isConnected && (
              <span className="inline-flex items-center gap-1 rounded-full border border-green-500/30 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                <Check className="size-2.5" />
                Connected
              </span>
            )}
          </div>
          {app?.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {app.description}
            </p>
          )}
        </div>
      </div>

      {/* Connect / Connections */}
      <div className="space-y-3">
        {activeConnections.length > 0 ? (
          <>
            <h2 className="text-sm font-medium text-muted-foreground">
              Active Connections
            </h2>
            <div className="space-y-2">
              {activeConnections.map((c: any) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3"
                >
                  <div>
                    <div className="text-sm font-medium">{c.app_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.status} · {c.created_at}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => disconnectApp.mutate(c.id)}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors"
                  >
                    <Link2Off className="size-3.5" />
                    Disconnect
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => connectApp.mutate()}
              disabled={connectApp.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
            >
              <Plug className="size-4" />
              Add another account
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => connectApp.mutate()}
            disabled={connectApp.isPending}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Plug className="size-4" />
            {connectApp.isPending ? "Connecting..." : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}
