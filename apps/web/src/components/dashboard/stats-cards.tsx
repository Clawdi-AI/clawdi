"use client";

interface Stats {
  total_sessions: number;
  total_messages: number;
  total_tokens: number;
  active_days: number;
  current_streak: number;
  longest_streak: number;
  peak_hour: number;
  favorite_model: string | null;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold mt-1 text-card-foreground">
        {value}
      </div>
    </div>
  );
}

export function StatsCards({ stats }: { stats: Stats }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      <Card label="Sessions" value={formatNumber(stats.total_sessions)} />
      <Card label="Messages" value={formatNumber(stats.total_messages)} />
      <Card label="Total tokens" value={formatNumber(stats.total_tokens)} />
      <Card label="Active days" value={String(stats.active_days)} />
      <Card label="Current streak" value={`${stats.current_streak}d`} />
      <Card label="Longest streak" value={`${stats.longest_streak}d`} />
      <Card label="Peak hour" value={`${stats.peak_hour}:00`} />
      <Card
        label="Favorite model"
        value={stats.favorite_model?.replace("claude-", "") ?? "-"}
      />
    </div>
  );
}
