"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

export default function SettingsPage() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const { data: keys, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/auth/keys", token);
    },
  });

  const createKey = useMutation({
    mutationFn: async (label: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>("/api/auth/keys", token, {
        method: "POST",
        body: JSON.stringify({ label }),
      });
    },
    onSuccess: (data) => {
      setCreatedKey(data.raw_key);
      setNewKeyLabel("");
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: async (keyId: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>(`/api/auth/keys/${keyId}`, token, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Profile */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Profile</h2>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Email:</span>{" "}
            {user?.primaryEmailAddress?.emailAddress}
          </div>
          <div className="text-sm mt-1">
            <span className="text-muted-foreground">Name:</span>{" "}
            {user?.fullName ?? "-"}
          </div>
        </div>
      </section>

      {/* API Keys */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          API Keys
        </h2>
        <p className="text-xs text-muted-foreground">
          Create API keys for the CLI. Use <code className="bg-muted px-1 py-0.5 rounded">clawdi login</code> and paste the key.
        </p>

        {/* Create new key */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newKeyLabel}
            onChange={(e) => setNewKeyLabel(e.target.value)}
            placeholder="Key label (e.g. my-laptop)"
            className="flex-1 border border-input bg-background rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => newKeyLabel && createKey.mutate(newKeyLabel)}
            disabled={!newKeyLabel || createKey.isPending}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Plus className="size-4" />
            Create
          </button>
        </div>

        {/* Show created key (once) */}
        {createdKey && (
          <div className="bg-card border border-primary/30 rounded-lg p-4 space-y-2">
            <div className="text-sm font-medium text-primary">
              API key created! Copy it now — it won't be shown again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted rounded px-3 py-2 text-xs font-mono break-all">
                {createdKey}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                }}
                className="p-2 hover:bg-muted rounded-lg transition-colors"
              >
                <Copy className="size-4" />
              </button>
            </div>
          </div>
        )}

        {/* Key list */}
        {isLoading ? (
          <div className="text-muted-foreground text-sm">Loading...</div>
        ) : keys?.length ? (
          <div className="border border-border rounded-lg divide-y divide-border">
            {keys.map((k: any) => (
              <div key={k.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{k.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {k.key_prefix}... &middot; Created {new Date(k.created_at).toLocaleDateString()}
                    {k.last_used_at && (
                      <> &middot; Last used {new Date(k.last_used_at).toLocaleDateString()}</>
                    )}
                    {k.revoked_at && (
                      <span className="text-destructive ml-1">Revoked</span>
                    )}
                  </div>
                </div>
                {!k.revoked_at && (
                  <button
                    type="button"
                    onClick={() => revokeKey.mutate(k.id)}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-muted rounded-lg transition-colors"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">No API keys yet.</div>
        )}
      </section>
    </div>
  );
}
