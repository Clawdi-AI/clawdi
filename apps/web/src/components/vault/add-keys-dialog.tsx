"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { buildKeyImportPreview } from "@/components/vault/key-import-logic";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { unwrap, useApi } from "@/lib/api";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

/* The #2 job of this dashboard: get keys in, fast. Paste-first composer —
 * a .env blob or a single KEY=value line, straight into any vault (with
 * inline create), from anywhere. No navigation required. */

const NEW_VAULT = "__new__";

export function AddKeysDialog({
	/** Pin the destination vault (vault detail page); omit for the picker. */
	vaultSlug,
	children,
}: {
	vaultSlug?: string;
	children?: React.ReactNode;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [vaultChoice, setVaultChoice] = useState<string>(vaultSlug ?? "");
	const [newVaultName, setNewVaultName] = useState("");
	const [updateExisting, setUpdateExisting] = useState(false);

	const vaultsQuery = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/v1/vault", { params: { query: { page_size: 200 } } })),
		enabled: open,
	});
	const projectsQuery = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
		enabled: open,
	});

	const ownVaults = useMemo(
		() => (vaultsQuery.data?.items ?? []).filter((v) => v.is_owner !== false),
		[vaultsQuery.data],
	);
	// Default destination: pinned slug, else the first vault, else create-new.
	const effectiveChoice = vaultChoice || (ownVaults.length > 0 ? ownVaults[0].slug : NEW_VAULT);
	const selectedVault = ownVaults.find((v) => v.slug === effectiveChoice);
	const selectedVaultProjectId = selectedVault?.project_ids?.[0] ?? undefined;
	const newVaultSlug = useMemo(() => slugFromVaultName(newVaultName), [newVaultName]);
	const newVaultSlugTaken =
		effectiveChoice === NEW_VAULT &&
		newVaultSlug.length > 0 &&
		ownVaults.some((v) => v.slug === newVaultSlug);
	const writableProject = useMemo(
		() =>
			(projectsQuery.data ?? []).find((p) => p.kind === "personal") ??
			(projectsQuery.data ?? []).find((p) => p.is_owner !== false),
		[projectsQuery.data],
	);
	const newVaultPending =
		effectiveChoice === NEW_VAULT &&
		!vaultSlug &&
		(vaultsQuery.isLoading || projectsQuery.isLoading);
	const newVaultUnavailable =
		effectiveChoice === NEW_VAULT &&
		!vaultSlug &&
		!vaultsQuery.isLoading &&
		!projectsQuery.isLoading &&
		!vaultsQuery.error &&
		!projectsQuery.error &&
		writableProject === undefined;
	const existingItems = useQuery({
		queryKey: ["vault-items", effectiveChoice, selectedVaultProjectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: {
						path: { slug: effectiveChoice },
						query: { project_id: selectedVaultProjectId },
					},
				}),
			),
		enabled: open && effectiveChoice !== NEW_VAULT && selectedVault !== undefined,
	});
	const existingDefaultKeys = useMemo(
		() => new Set(existingItems.data?.["(default)"] ?? []),
		[existingItems.data],
	);
	const importPlan = useMemo(
		() => buildKeyImportPreview(text, existingDefaultKeys, updateExisting),
		[text, existingDefaultKeys, updateExisting],
	);
	const count = importPlan.parsed.entries.length;
	const importableCount = importPlan.importableRows.length;
	const destinationPending =
		open &&
		effectiveChoice !== NEW_VAULT &&
		(vaultsQuery.isLoading || selectedVault === undefined || existingItems.isLoading);
	const destinationLoadError =
		vaultsQuery.error ?? (effectiveChoice === NEW_VAULT ? projectsQuery.error : null);
	const canSave =
		importPlan.parsed.errors.length === 0 &&
		importableCount > 0 &&
		!saveDisabledForNewVault(effectiveChoice, vaultSlug, newVaultName, newVaultSlug) &&
		!newVaultSlugTaken &&
		!newVaultPending &&
		!newVaultUnavailable &&
		!destinationPending &&
		!destinationLoadError &&
		!existingItems.error;

	const save = useMutation({
		mutationFn: async () => {
			let slug = effectiveChoice;
			let projectId: string | undefined;
			if (slug === NEW_VAULT) {
				const name = newVaultName.trim();
				if (!name) throw new Error("Name the new vault first");
				slug = newVaultSlug;
				if (!slug) throw new Error("Use letters or numbers in the vault name");
				if (ownVaults.some((v) => v.slug === slug)) {
					throw new Error("A vault with that name already exists");
				}
				if (!writableProject) throw new Error("No writable Project available yet");
				projectId = writableProject.id;
				await unwrap(
					await api.POST("/v1/vault", {
						params: { query: { project_id: projectId, create_only: true } },
						body: { slug, name },
					}),
				);
			} else {
				projectId = selectedVaultProjectId;
			}
			// API caps 200 fields per write; chunk for big pastes.
			const entries = Object.entries(importPlan.fields);
			if (entries.length === 0) throw new Error("No keys to save");
			for (let i = 0; i < entries.length; i += 150) {
				await unwrap(
					await api.PUT("/v1/vault/{slug}/items", {
						params: { path: { slug }, query: { project_id: projectId } },
						body: { section: "", fields: Object.fromEntries(entries.slice(i, i + 150)) },
					}),
				);
			}
			return { slug, summary: importPlan.summary };
		},
		onSuccess: ({ slug, summary }) => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			qc.invalidateQueries({ queryKey: ["vault-items", slug] });
			const changed = summary.created + summary.updated;
			toast.success(`${changed} ${changed === 1 ? "key" : "keys"} saved`, {
				description:
					summary.updated > 0 || summary.skipped > 0
						? `${summary.created} new, ${summary.updated} updated, ${summary.skipped} skipped in vault://${slug}.`
						: `In vault://${slug}. Agents read them through the CLI at runtime.`,
			});
			setOpen(false);
		},
		onError: (e) => toast.error("Couldn't save keys", { description: errorMessage(e) }),
	});

	useEffect(() => {
		if (!open) return;
		setText("");
		setNewVaultName("");
		setVaultChoice(vaultSlug ?? "");
		setUpdateExisting(false);
	}, [open, vaultSlug]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{children ?? (
					<Button size="sm">
						<Plus className="size-3.5" />
						Add keys
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add keys</DialogTitle>
					<DialogDescription>
						Paste <span className="font-mono">KEY=value</span> lines or a flat JSON object.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<Textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={"OPENAI_API_KEY=sk-…\nGITHUB_TOKEN=ghp_…"}
						rows={7}
						autoFocus
						spellCheck={false}
						className="resize-none font-mono text-xs"
					/>
					{!vaultSlug ? (
						<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
							<div className="space-y-1.5">
								<Label htmlFor="add-keys-vault">Into vault</Label>
								<Select value={effectiveChoice} onValueChange={setVaultChoice}>
									<SelectTrigger id="add-keys-vault" className="w-full">
										<SelectValue placeholder="Choose a vault…" />
									</SelectTrigger>
									<SelectContent>
										{ownVaults.map((v) => (
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
								<div className="space-y-1">
									<Input
										value={newVaultName}
										onChange={(e) => setNewVaultName(e.target.value)}
										placeholder="Vault name…"
										aria-label="New vault name"
										className="sm:w-44"
									/>
									{newVaultSlugTaken ? (
										<p className="max-w-44 text-xs text-destructive">
											That vault already exists. Choose it from the list or use a different name.
										</p>
									) : null}
									{newVaultUnavailable ? (
										<p className="max-w-44 text-xs text-destructive">
											No writable Project is available yet.
										</p>
									) : null}
								</div>
							) : null}
						</div>
					) : null}
					{destinationLoadError ? (
						<ApiErrorPanel
							error={destinationLoadError}
							onRetry={() => {
								if (vaultsQuery.error) void vaultsQuery.refetch();
								if (effectiveChoice === NEW_VAULT && projectsQuery.error) {
									void projectsQuery.refetch();
								}
							}}
							title="Couldn't load destinations"
						/>
					) : null}
					{importPlan.parsed.errors.length > 0 ? (
						<Alert variant="destructive">
							<AlertCircle className="size-4" />
							<AlertTitle>Fix import text</AlertTitle>
							<AlertDescription>
								<ul className="max-h-32 list-disc space-y-1 overflow-auto pl-4">
									{importPlan.parsed.errors.map((error, index) => (
										<li key={`${index}-${error}`}>{error}</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}
					{existingItems.error ? (
						<ApiErrorPanel
							error={existingItems.error}
							onRetry={() => {
								void existingItems.refetch();
							}}
							title="Couldn't check existing keys"
						/>
					) : null}
					{importPlan.conflicts.length > 0 && importPlan.parsed.errors.length === 0 ? (
						<div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
							<Checkbox
								id="add-keys-update-existing"
								checked={updateExisting}
								onCheckedChange={(checked) => setUpdateExisting(checked === true)}
								className="mt-0.5"
							/>
							<div className="space-y-1">
								<Label htmlFor="add-keys-update-existing" className="text-sm font-medium">
									Overwrite existing keys
								</Label>
								<p className="text-xs text-muted-foreground">
									{importPlan.conflicts.length} key
									{importPlan.conflicts.length === 1 ? "" : "s"} already exist. By default, they are
									skipped.
								</p>
							</div>
						</div>
					) : null}
					{importPlan.preview.length > 0 && importPlan.parsed.errors.length === 0 ? (
						<div className="rounded-md border">
							<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
								<p className="text-xs font-medium">Preview</p>
								<div className="flex flex-wrap gap-1.5">
									<Badge variant="secondary">{importPlan.summary.created} new</Badge>
									{importPlan.conflicts.length > 0 ? (
										<Badge variant="outline">
											{updateExisting
												? `${importPlan.summary.updated} update`
												: `${importPlan.summary.skipped} skip`}
										</Badge>
									) : null}
								</div>
							</div>
							<div className="max-h-44 divide-y overflow-auto">
								{importPlan.preview.slice(0, 10).map((entry) => (
									<div
										key={`${entry.line ?? "json"}-${entry.key}`}
										className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-sm"
									>
										<span className="truncate font-mono text-xs" translate="no">
											{entry.key}
										</span>
										<KeyImportActionBadge action={entry.action} />
									</div>
								))}
								{importPlan.preview.length > 10 ? (
									<p className="px-3 py-2 text-xs text-muted-foreground">
										{importPlan.preview.length - 10} more key
										{importPlan.preview.length - 10 === 1 ? "" : "s"} ready.
									</p>
								) : null}
							</div>
						</div>
					) : null}
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-muted-foreground tabular-nums">
							{count} {count === 1 ? "key" : "keys"} detected
							{importPlan.summary.skipped > 0 ? ` · ${importPlan.summary.skipped} skipped` : ""}
						</span>
						<Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
							{save.isPending ? <Spinner /> : <Check className="size-3.5" />}
							Save {importableCount > 0 ? importableCount : ""}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function saveDisabledForNewVault(
	effectiveChoice: string,
	vaultSlug: string | undefined,
	newVaultName: string,
	newVaultSlug: string,
): boolean {
	return effectiveChoice === NEW_VAULT && !vaultSlug && (!newVaultName.trim() || !newVaultSlug);
}

function KeyImportActionBadge({ action }: { action: "create" | "update" | "skip" }) {
	return (
		<Badge variant={action === "create" ? "secondary" : "outline"}>
			{action === "create" ? "New" : action === "update" ? "Update" : "Skip"}
		</Badge>
	);
}
