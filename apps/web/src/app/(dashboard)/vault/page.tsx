"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Key, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

export default function VaultPage() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [newVaultSlug, setNewVaultSlug] = useState("");

  const { data: vaults, isLoading } = useQuery({
    queryKey: ["vaults"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/vault", token);
    },
  });

  const createVault = useMutation({
    mutationFn: async (slug: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>("/api/vault", token, {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
    },
    onSuccess: () => {
      setNewVaultSlug("");
      queryClient.invalidateQueries({ queryKey: ["vaults"] });
    },
  });

  const deleteVault = useMutation({
    mutationFn: async (slug: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>(`/api/vault/${slug}`, token, { method: "DELETE" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vaults"] }),
  });

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-bold">Vault</h1>
      <p className="text-sm text-muted-foreground">
        Encrypted secrets synced to your agents via{" "}
        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi run</code>.
        Values are never visible in the browser.
      </p>

      {/* Create vault */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newVaultSlug}
          onChange={(e) => setNewVaultSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          placeholder="New vault name (e.g. ai-keys, prod)"
          className="flex-1 border border-input bg-background rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter" && newVaultSlug) createVault.mutate(newVaultSlug);
          }}
        />
        <button
          type="button"
          onClick={() => newVaultSlug && createVault.mutate(newVaultSlug)}
          disabled={!newVaultSlug || createVault.isPending}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Plus className="size-4" />
          Create
        </button>
      </div>

      {/* Vault list */}
      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : vaults?.length ? (
        <div className="space-y-4">
          {vaults.map((v: any) => (
            <VaultCard
              key={v.id}
              vault={v}
              onDelete={() => deleteVault.mutate(v.slug)}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No vaults yet. Create one above or run{" "}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi vault set KEY</code>
        </p>
      )}
    </div>
  );
}

function VaultCard({ vault, onDelete }: { vault: any; onDelete: () => void }) {
  const { getToken } = useAuth();
  const { data: items } = useQuery({
    queryKey: ["vault-items", vault.slug],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<Record<string, string[]>>(`/api/vault/${vault.slug}/items`, token);
    },
  });

  const allFields = items
    ? Object.entries(items).flatMap(([section, fields]) =>
        fields.map((f) => (section === "(default)" ? f : `${section}/${f}`)),
      )
    : [];

  return (
    <div className="bg-card border border-border rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Key className="size-4 text-primary" />
          <span className="font-medium text-sm">{vault.slug}</span>
          <span className="text-xs text-muted-foreground">
            {allFields.length} {allFields.length === 1 ? "key" : "keys"}
          </span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted rounded-md transition-colors"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {allFields.length > 0 && (
        <div className="px-4 py-2 space-y-1">
          {allFields.map((f) => (
            <div key={f} className="flex items-center justify-between text-sm py-0.5">
              <span className="font-mono text-xs">{f}</span>
              <span className="text-xs text-muted-foreground">••••••••</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
