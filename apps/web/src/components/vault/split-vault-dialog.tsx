"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scissors } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];

/* Grab-bag vaults accumulate app-scoped keys named `app/KEY` (legacy
 * imports). This wizard splits them out: one vault per prefix, keys
 * renamed to their clean suffix via the copy endpoint's strip_prefix
 * (values never leave the server), originals removed. The 340-key
 * default vault becomes a dozen tidy app vaults in one click. */

const CHUNK = 150;

export type PrefixGroup = {
	prefix: string;
	slug: string;
	keys: { section: string; name: string }[];
};

/** Group slash-prefixed key names by their first segment. Only prefixes
 * holding ≥2 keys count — a single stray slash isn't an app. */
export function prefixGroupsFor(keyNames: { section: string; name: string }[]): PrefixGroup[] {
	const bySlug = new Map<string, PrefixGroup>();
	for (const k of keyNames) {
		const m = k.name.match(/^([A-Za-z0-9_.-]+)\/.+/);
		if (!m) continue;
		const prefix = `${m[1]}/`;
		const slug = m[1]
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!slug) continue;
		const group = bySlug.get(slug);
		if (group) group.keys.push(k);
		else bySlug.set(slug, { prefix, slug, keys: [k] });
	}
	return [...bySlug.values()]
		.filter((g) => g.keys.length >= 2)
		.sort((a, b) => b.keys.length - a.keys.length || a.slug.localeCompare(b.slug));
}

export function SplitVaultDialog({
	vault,
	groups,
	onDone,
}: {
	vault: VaultSummary;
	groups: PrefixGroup[];
	onDone?: () => void;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [excluded, setExcluded] = useState<Set<string>>(new Set());
	const [removeOriginals, setRemoveOriginals] = useState(true);
	const [progress, setProgress] = useState<string | null>(null);

	const anyProjectId = vault.project_ids?.[0];
	const selected = useMemo(() => groups.filter((g) => !excluded.has(g.slug)), [groups, excluded]);
	const selectedKeyCount = selected.reduce((n, g) => n + g.keys.length, 0);

	const projectsQuery = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
		enabled: open,
	});
	const projects = projectsQuery.data;

	const run = useMutation({
		mutationFn: async () => {
			const personal =
				(projects ?? []).find((p) => p.kind === "personal") ??
				(projects ?? []).find((p) => p.is_owner !== false);
			if (!personal) throw new Error("No writable Project available yet");
			let done = 0;
			let affectedKeys = 0;
			const failed: string[] = [];
			for (const group of selected) {
				setProgress(`${group.slug} (${done + 1}/${selected.length})…`);
				try {
					const target = unwrap(
						await api.POST("/v1/vault", {
							params: { query: { project_id: personal.id, create_only: true } },
							body: { slug: group.slug, name: group.prefix.slice(0, -1) },
						}),
					);
					// Group by section, then chunked copy with rename + delete.
					const bySection = new Map<string, string[]>();
					let copiedInGroup = 0;
					for (const k of group.keys) {
						const section = k.section === "(default)" ? "" : k.section;
						const bucket = bySection.get(section);
						if (bucket) bucket.push(k.name);
						else bySection.set(section, [k.name]);
					}
					for (const [section, names] of bySection) {
						for (let i = 0; i < names.length; i += CHUNK) {
							const fields = names.slice(i, i + CHUNK);
							const result = unwrap(
								await api.POST("/v1/vault/{slug}/items/copy", {
									params: {
										path: { slug: vault.slug },
										query: {
											project_id: anyProjectId ?? undefined,
											vault_id: vault.id,
											target_vault_id: target.id,
										},
									},
									body: {
										target_slug: group.slug,
										section,
										fields,
										strip_prefix: group.prefix,
									},
								}),
							);
							copiedInGroup += result.copied;
							if (removeOriginals) {
								if (result.copied > 0) {
									await unwrap(
										await api.DELETE("/v1/vault/{slug}/items", {
											params: {
												path: { slug: vault.slug },
												query: {
													project_id: anyProjectId ?? undefined,
													vault_id: vault.id,
													global_delete: true,
												},
											},
											body: { section, fields },
										}),
									);
								}
							}
						}
					}
					if (copiedInGroup === 0) throw new Error("No keys copied");
					done += 1;
					affectedKeys += copiedInGroup;
				} catch {
					failed.push(group.slug);
				}
			}
			if (done === 0) {
				throw new Error(
					failed.length > 0 ? `Couldn't split ${failed.join(", ")}` : "No vaults selected",
				);
			}
			return { done, failed, affectedKeys };
		},
		onSuccess: ({ done, failed, affectedKeys }) => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			qc.invalidateQueries({ queryKey: ["vault-items"] });
			setProgress(null);
			toast.success(`Split into ${done} ${done === 1 ? "vault" : "vaults"}`, {
				description:
					`${affectedKeys} keys ${removeOriginals ? "moved" : "copied"} with clean names.` +
					(failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : ""),
			});
			setOpen(false);
			onDone?.();
		},
		onError: (e) => {
			setProgress(null);
			toast.error("Couldn't split vault", { description: errorMessage(e) });
		},
	});

	return (
		<Dialog open={open} onOpenChange={(next) => !run.isPending && setOpen(next)}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<Scissors className="size-3.5" />
				Split into vaults…
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Split {vault.name} by app prefix</DialogTitle>
					<DialogDescription>
						Keys named <span className="font-mono">app/KEY</span> become a vault per app, renamed to
						their clean <span className="font-mono">KEY</span>. Values stay server-side.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
						{groups.map((g) => {
							const checked = !excluded.has(g.slug);
							return (
								<label
									key={g.slug}
									htmlFor={`split-prefix-${g.slug}`}
									className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/50"
								>
									<Checkbox
										id={`split-prefix-${g.slug}`}
										checked={checked}
										onCheckedChange={(v) => {
											setExcluded((prev) => {
												const next = new Set(prev);
												if (v === true) next.delete(g.slug);
												else next.add(g.slug);
												return next;
											});
										}}
									/>
									<span aria-hidden className="select-none text-sm leading-none">
										{identityFor(g.slug).emoji}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-xs">{g.prefix}</span>
									<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
										{g.keys.length} keys → vault://{g.slug}
									</span>
								</label>
							);
						})}
					</div>
					<div className="flex items-center gap-2">
						<Checkbox
							id="split-remove-originals"
							checked={removeOriginals}
							onCheckedChange={(v) => setRemoveOriginals(v === true)}
						/>
						<Label htmlFor="split-remove-originals" className="text-sm font-normal">
							Remove the originals from {vault.name} (move)
						</Label>
					</div>
					{removeOriginals && (vault.project_ids?.length ?? 0) > 1 ? (
						<p className="text-xs font-medium text-warning-muted-foreground">
							{vault.name} is used by {vault.project_ids?.length} Projects — moved keys leave all of
							them. Add the new vaults to those Projects afterwards.
						</p>
					) : null}
					{projectsQuery.error ? (
						<ApiErrorPanel
							error={projectsQuery.error}
							onRetry={() => {
								void projectsQuery.refetch();
							}}
							title="Couldn't load destinations"
						/>
					) : null}
					<Button
						className="w-full"
						disabled={
							selected.length === 0 ||
							run.isPending ||
							projectsQuery.isLoading ||
							!!projectsQuery.error
						}
						onClick={() => run.mutate()}
					>
						{run.isPending ? <Spinner /> : <Scissors className="size-3.5" />}
						{run.isPending && progress
							? `Splitting ${progress}`
							: `Split ${selectedKeyCount} keys into ${selected.length} ${selected.length === 1 ? "vault" : "vaults"}`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
