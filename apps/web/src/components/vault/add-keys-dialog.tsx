"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { unwrap, useApi } from "@/lib/api";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

/* The #2 job of this dashboard: get keys in, fast. Paste-first composer —
 * a .env blob or a single KEY=value line, straight into any vault (with
 * inline create), from anywhere. No navigation required. */

const NEW_VAULT = "__new__";

/** dotenv-style parser: `export` prefixes, quotes, comments handled. */
export function parseKeyLines(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line
			.slice(0, eq)
			.trim()
			.replace(/^export\s+/, "")
			.toUpperCase()
			.replace(/[^A-Z0-9_]/g, "_");
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key && value) out[key] = value;
	}
	return out;
}

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

	const ownVaults = useMemo(
		() => (vaults?.items ?? []).filter((v) => v.is_owner !== false),
		[vaults],
	);
	const fields = useMemo(() => parseKeyLines(text), [text]);
	const count = Object.keys(fields).length;

	// Default destination: pinned slug, else the first vault, else create-new.
	const effectiveChoice = vaultChoice || (ownVaults.length > 0 ? ownVaults[0].slug : NEW_VAULT);

	const save = useMutation({
		mutationFn: async () => {
			let slug = effectiveChoice;
			let projectId: string | undefined;
			if (slug === NEW_VAULT) {
				const name = newVaultName.trim();
				if (!name) throw new Error("Name the new vault first");
				slug = name
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, "-")
					.replace(/-{2,}/g, "-")
					.replace(/^-+|-+$/g, "");
				const personal =
					(projects ?? []).find((p) => p.kind === "personal") ??
					(projects ?? []).find((p) => p.is_owner !== false);
				if (!personal) throw new Error("No writable Project available yet");
				projectId = personal.id;
				await unwrap(
					await api.POST("/api/vault", {
						params: { query: { project_id: projectId } },
						body: { slug, name },
					}),
				);
			} else {
				projectId = ownVaults.find((v) => v.slug === slug)?.project_ids?.[0] ?? undefined;
			}
			// API caps 200 fields per write; chunk for big pastes.
			const entries = Object.entries(fields);
			for (let i = 0; i < entries.length; i += 150) {
				await unwrap(
					await api.PUT("/api/vault/{slug}/items", {
						params: { path: { slug }, query: { project_id: projectId } },
						body: { section: "", fields: Object.fromEntries(entries.slice(i, i + 150)) },
					}),
				);
			}
			return slug;
		},
		onSuccess: (slug) => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			qc.invalidateQueries({ queryKey: ["vault-items", slug] });
			toast.success(`${count} ${count === 1 ? "key" : "keys"} saved`, {
				description: `In vault://${slug}. Agents read them through the CLI at runtime.`,
			});
			setOpen(false);
			setText("");
			setNewVaultName("");
		},
		onError: (e) => toast.error("Couldn't save keys", { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setText("");
					setNewVaultName("");
					setVaultChoice(vaultSlug ?? "");
				}
			}}
		>
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
						Paste <span className="font-mono">KEY=value</span> lines — one key or a whole .env file.
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
								<Input
									value={newVaultName}
									onChange={(e) => setNewVaultName(e.target.value)}
									placeholder="Vault name…"
									aria-label="New vault name"
									className="sm:w-44"
								/>
							) : null}
						</div>
					) : null}
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-muted-foreground tabular-nums">
							{count} {count === 1 ? "key" : "keys"} detected
						</span>
						<Button
							onClick={() => save.mutate()}
							disabled={
								count === 0 ||
								save.isPending ||
								(effectiveChoice === NEW_VAULT && !newVaultName.trim() && !vaultSlug)
							}
						>
							{save.isPending ? <Spinner /> : <Check className="size-3.5" />}
							Save {count > 0 ? count : ""}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
