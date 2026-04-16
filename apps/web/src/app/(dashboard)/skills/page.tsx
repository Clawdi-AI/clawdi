"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { FEATURED_SKILLS, type FeaturedSkill } from "@clawdi-cloud/shared/consts";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function SkillsPage() {
  const [tab, setTab] = useState<"my" | "marketplace">("my");

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Skills</h1>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          {(["my", "marketplace"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm transition-colors",
                tab === t
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "my" ? "My Skills" : "Marketplace"}
            </button>
          ))}
        </div>
      </div>

      {tab === "my" ? <MySkills /> : <Marketplace />}
    </div>
  );
}

function MySkills() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { data: skills, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any[]>("/api/skills", token);
    },
  });

  const deleteSkill = useMutation({
    mutationFn: async (key: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      return apiFetch<any>(`/api/skills/${key}`, token, { method: "DELETE" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>;

  if (!skills?.length) {
    return (
      <div className="text-muted-foreground text-sm">
        No skills installed. Browse the <strong>Marketplace</strong> tab to discover skills.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {skills.map((s: any) => (
        <div
          key={s.id}
          className="bg-card border border-border rounded-lg p-4 flex items-start justify-between"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary shrink-0" />
              <span className="font-medium text-sm">{s.skill_key}</span>
              <span className="text-xs text-muted-foreground">v{s.version}</span>
            </div>
            {s.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.description}</p>
            )}
            <div className="text-xs text-muted-foreground mt-1.5">
              {s.source}
              {s.source_repo && (
                <span> · {s.source_repo}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => deleteSkill.mutate(s.skill_key)}
            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted rounded-md transition-colors"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Marketplace() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [customRepo, setCustomRepo] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);

  const installSkill = async (repo: string, path?: string) => {
    const key = `${repo}/${path || ""}`;
    setInstalling(key);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      await apiFetch("/api/skills/install", token, {
        method: "POST",
        body: JSON.stringify({ repo, path }),
      });
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    } catch (e: any) {
      alert(`Failed to install: ${e.message}`);
    } finally {
      setInstalling(null);
    }
  };

  const handleCustomInstall = async () => {
    if (!customRepo.trim()) return;
    const clean = customRepo.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
    const parts = clean.split("/");
    const repo = `${parts[0]}/${parts[1]}`;
    const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
    await installSkill(repo, path);
    setCustomRepo("");
  };

  return (
    <div className="space-y-6">
      {/* Custom install */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={customRepo}
            onChange={(e) => setCustomRepo(e.target.value)}
            placeholder="owner/repo or GitHub URL..."
            className="w-full border border-input bg-background rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCustomInstall();
            }}
          />
        </div>
        <button
          type="button"
          onClick={handleCustomInstall}
          disabled={!customRepo.trim() || !!installing}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Plus className="size-4" />
          Install
        </button>
      </div>

      {/* Featured skills */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">Popular Skills</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {FEATURED_SKILLS.map((skill) => {
            const key = `${skill.repo}/${skill.path || ""}`;
            const isInstalling = installing === key;
            return (
              <div
                key={key}
                className="bg-card border border-border rounded-lg p-4 flex items-start justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary shrink-0" />
                    <span className="font-medium text-sm">{skill.name}</span>
                    <span className="text-xs text-muted-foreground">{skill.installs}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {skill.description}
                  </p>
                  <div className="text-xs text-muted-foreground mt-1.5">
                    {skill.repo}{skill.path ? `/${skill.path}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => installSkill(skill.repo, skill.path)}
                  disabled={isInstalling}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity shrink-0 ml-3"
                >
                  <Download className="size-3" />
                  {isInstalling ? "..." : "Install"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Browse more skills at{" "}
        <a
          href="https://skills.sh"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline inline-flex items-center gap-0.5"
        >
          skills.sh <ExternalLink className="size-3" />
        </a>
      </p>
    </div>
  );
}
