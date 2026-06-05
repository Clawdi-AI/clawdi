"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];

/* The grab-bag escape hatch: batch-selected keys leave the default vault
 * for a named one. Values never reach the browser — `/items/copy` does the
 * decrypt/re-encrypt server-side; "move" is copy + delete-at-source. */

const NEW_VAULT = "__new__";
const CHUNK = 150; // API caps fields per request at 200

export function CopyKeysDialog({
	vault,
	keys,
	mode,
	onDone,
	children,
}: {
	vault: VaultSummary;
	keys: { section: string; name: string }[];
	mode: "copy" | "move";
	/** Called after success — the parent clears its selection. */
	onDone?: () => void;
	children: React.ReactNode;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [targetChoice, setTargetChoice] = useState("");
	const [newVaultName, setNewVaultName] = useState("");

	const anyProjectId = vault.project_ids?.[0];
	const attachedCount = vault.project_ids?.length ?? 0;
	const verb = mode === "move" ? "Move" : "Copy";

	const { data: vaults } = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/api/vault", { params: { query: { page_size: 200 } } })),
		enabled: open,
	});
	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/api/projects")),
		enabled: open,
	});
	const targetVaults = useMemo(
		() => (vaults?.items ?? []).filter((v) => v.is_owner !== false && v.slug !== vault.slug),
		[vaults, vault.slug],
	);
	const effectiveChoice =
		targetChoice || (targetVaults.length > 0 ? targetVaults[0].slug : NEW_VAULT);

	const run = useMutation({
		mutationFn: async () => {
			let targetSlug = effectiveChoice;
			if (targetSlug === NEW_VAULT) {
				const name = newVaultName.trim();
				if (!name) throw new Error("Name the new vault first");
				targetSlug = name
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, "-")
					.replace(/-{2,}/g, "-")
					.replace(/^-+|-+$/g, "");
				const personal =
					(projects ?? []).find((p) => p.kind === "personal") ??
					(projects ?? []).find((p) => p.is_owner !== false);
				if (!personal) throw new Error("No writable Project available yet");
				await unwrap(
					await api.POST("/api/vault", {
						params: { query: { project_id: personal.id } },
						body: { slug: targetSlug, name },
					}),
				);
			}
			// Group by section — the copy endpoint works per section.
			const bySection = new Map<string, string[]>();
			for (const k of keys) {
				const section = k.section === "(default)" ? "" : k.section;
				const bucket = bySection.get(section);
				if (bucket) bucket.push(k.name);
				else bySection.set(section, [k.name]);
			}
			for (const [section, names] of bySection) {
				for (let i = 0; i < names.length; i += CHUNK) {
					const fields = names.slice(i, i + CHUNK);
					await unwrap(
						await api.POST("/api/vault/{slug}/items/copy", {
							params: {
								path: { slug: vault.slug },
								query: { project_id: anyProjectId ?? undefined },
							},
							body: { target_slug: targetSlug, section, fields },
						}),
					);
					if (mode === "move") {
						await unwrap(
							await api.DELETE("/api/vault/{slug}/items", {
								params: {
									path: { slug: vault.slug },
									query: { project_id: anyProjectId ?? undefined, global_delete: true },
								},
								body: { section, fields },
							}),
						);
					}
				}
			}
			return targetSlug;
		},
		onSuccess: (targetSlug) => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			qc.invalidateQueries({ queryKey: ["vault-items"] });
			toast.success(
				`${keys.length} ${keys.length === 1 ? "key" : "keys"} ${mode === "move" ? "moved" : "copied"}`,
				{
					description: `Now in vault://${targetSlug}.`,
				},
			);
			setOpen(false);
			setTargetChoice("");
			setNewVaultName("");
			onDone?.();
		},
		onError: (e) => toast.error(`Couldn't ${mode} keys`, { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setTargetChoice("");
					setNewVaultName("");
				}
			}}
		>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{verb} {keys.length} {keys.length === 1 ? "key" : "keys"} to…
					</DialogTitle>
					{/* Copy-vs-reference semantics must be explicit (Kingsley's
					    review): a copied key is an independent secret — rotating
					    one later does NOT update the other. When the user's real
					    goal is "use these keys elsewhere too", the reference move
					    (add this vault to that Project) is the right tool, so
					    offer it right here. */}
					<DialogDescription>
						{mode === "move"
							? "Values stay server-side; the originals are removed from this vault."
							: "Each key becomes an independent copy — changing a value later updates only one vault, not both."}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
						<div className="space-y-1.5">
							<Label htmlFor="copy-keys-target">Destination vault</Label>
							<Select value={effectiveChoice} onValueChange={setTargetChoice}>
								<SelectTrigger id="copy-keys-target" className="w-full">
									<SelectValue placeholder="Choose a vault…" />
								</SelectTrigger>
								<SelectContent className="max-h-80">
									{targetVaults.map((v) => (
										<SelectItem key={v.slug} value={v.slug}>
											<span aria-hidden className="select-none">
												{identityFor(v.name).emoji}
											</span>
											{v.name}
										</SelectItem>
									))}
									<SelectItem value={NEW_VAULT}>
										<Plus className="size-3.5" />
										New vault…
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{effectiveChoice === NEW_VAULT ? (
							<Input
								value={newVaultName}
								onChange={(e) => setNewVaultName(e.target.value)}
								placeholder="Vault name…"
								aria-label="New vault name"
								className="sm:w-44"
							/>
						) : null}
					</div>
					{mode === "move" && attachedCount > 1 ? (
						<p className="text-xs font-medium text-warning-muted-foreground">
							{vault.name} is used by {attachedCount} Projects — moving these keys removes them from
							all of those Projects.
						</p>
					) : null}
					{mode === "copy" ? (
						<p className="text-xs text-muted-foreground">
							Just want these keys available in another Project? Use{" "}
							<span className="font-medium text-foreground">Add to Project</span> on this vault
							instead — one source of truth, changes apply everywhere.
						</p>
					) : null}
					<Button
						className="w-full"
						disabled={run.isPending || (effectiveChoice === NEW_VAULT && !newVaultName.trim())}
						onClick={() => run.mutate()}
					>
						{run.isPending ? <Spinner /> : <ArrowRight className="size-3.5" />}
						{verb} {keys.length} {keys.length === 1 ? "key" : "keys"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
