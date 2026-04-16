"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export default function SessionsPage() {
  const { getToken } = useAuth();

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/sessions?limit=100", token);
    },
  });

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">Sessions</h1>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : sessions?.length ? (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Summary</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Project</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Model</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Messages</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Tokens</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Date</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 max-w-xs truncate">
                    {s.summary || s.local_session_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {s.project_path?.split("/").pop() ?? "-"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {s.model?.replace("claude-", "") ?? "-"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{s.message_count}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {((s.input_tokens + s.output_tokens) / 1000).toFixed(1)}k
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">
                    {new Date(s.started_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-muted-foreground">
          No sessions yet. Run <code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi sync up</code> to sync.
        </div>
      )}
    </div>
  );
}
