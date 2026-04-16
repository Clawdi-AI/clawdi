"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Link2, Link2Off, Search } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

export default function ConnectorsPage() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: connections } = useQuery({
    queryKey: ["connections"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/connectors", token);
    },
  });

  const { data: availableApps, isLoading: appsLoading } = useQuery({
    queryKey: ["available-apps", search],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const params = search ? `?search=${encodeURIComponent(search)}` : "";
      return apiFetch<any[]>(`/api/connectors/available${params}`, token);
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
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["connections"] }), 3000);
    },
  });

  const disconnectApp = useMutation({
    mutationFn: async (connectionId: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>(`/api/connectors/${connectionId}`, token, { method: "DELETE" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  const connectedAppNames = new Set(connections?.map((c: any) => c.app_name) ?? []);

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-bold">Connectors</h1>
      <p className="text-sm text-muted-foreground">
        Connect third-party services. Once connected, tools are available in any agent via MCP.
      </p>

      {/* My Connections */}
      {connections && connections.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">My Connections</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {connections.map((c: any) => (
              <div
                key={c.id}
                className="bg-card border border-border rounded-lg p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <Link2 className="size-5 text-primary" />
                  <div>
                    <div className="text-sm font-medium">{c.app_name}</div>
                    <div className="text-xs text-muted-foreground">{c.status}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => disconnectApp.mutate(c.id)}
                  className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted rounded-md transition-colors"
                  title="Disconnect"
                >
                  <Link2Off className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Available Apps */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Available Apps</h2>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps..."
            className="w-full border border-input bg-background rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {appsLoading ? (
          <div className="text-muted-foreground text-sm">Loading apps...</div>
        ) : availableApps?.length ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {availableApps.map((app: any) => {
              const isConnected = connectedAppNames.has(app.name);
              return (
                <div
                  key={app.name}
                  className="bg-card border border-border rounded-lg p-3 flex flex-col items-center gap-2 text-center"
                >
                  {app.logo ? (
                    <img
                      src={app.logo}
                      alt={app.display_name}
                      className="size-8 rounded"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="size-8 rounded bg-muted flex items-center justify-center text-xs font-medium">
                      {app.display_name?.[0] ?? "?"}
                    </div>
                  )}
                  <span className="text-xs font-medium truncate w-full">{app.display_name}</span>
                  {isConnected ? (
                    <span className="text-xs text-primary">Connected</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => connectApp.mutate(app.name)}
                      disabled={connectApp.isPending}
                      className="text-xs px-3 py-1 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      Connect
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">
            {search ? `No apps matching "${search}"` : "No apps available. Configure COMPOSIO_API_KEY."}
          </div>
        )}
      </section>
    </div>
  );
}
