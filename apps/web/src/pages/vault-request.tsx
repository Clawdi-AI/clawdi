import type { components, paths } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	MAX_ENV_IMPORT_BYTES,
	type ParsedKey,
	parseVaultRequestEnv,
	REQUEST_FIELD_NAME_RE,
} from "@/components/vault/key-import-parse";
import { env } from "@/lib/env";

type RequestContext = components["schemas"]["VaultSecretRequestStatus"];
const client = createClient<paths>({ baseUrl: env.VITE_CLAWDI_API_URL });
const UNAVAILABLE =
	"This request has changed or its link has expired. Ask your agent for a new link.";

export function VaultRequestPage() {
	const token = useRef("");
	const [context, setContext] = useState<RequestContext>();
	const [rows, setRows] = useState<
		{ id: string; name: string; value: string; required: boolean }[]
	>([]);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [preview, setPreview] = useState<{ entries: ParsedKey[]; updateFields: string[] }>();
	const [selectionError, setSelectionError] = useState("");
	const [selectionRetryable, setSelectionRetryable] = useState(false);
	const selectionGeneration = useRef(0);
	const [importBusy, setImportBusy] = useState(false);
	const [updates, setUpdates] = useState<string[]>([]);
	const [selectionAttempt, setSelectionAttempt] = useState(0);
	const [selectionReady, setSelectionReady] = useState(false);
	const names = JSON.stringify(rows.map((row) => row.name));
	const [phase, setPhase] = useState<
		"loading" | "ready" | "saving" | "done" | "unavailable" | "error"
	>("loading");
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
	const agentMessage =
		phase === "done" && context
			? `I've saved the requested credentials. Please check Vault request ${context.id}; once its status is supplied, continue our previous task using existing authorized capabilities. Do not include secret values in chat.`
			: "";

	async function copyMessage() {
		if (!agentMessage || copyState === "copying") return;
		setCopyState("copying");
		try {
			await navigator.clipboard.writeText(agentMessage);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	}

	useEffect(() => {
		// Remove the capability from browser history before making any request.
		if (!token.current) token.current = window.location.hash.slice(1);
		window.history.replaceState(null, "", window.location.pathname);
		if (!/^v2_[A-Za-z0-9_-]{43}$/.test(token.current)) {
			setPhase("unavailable");
			return;
		}
		const controller = new AbortController();
		setPhase("loading");
		void client
			.POST("/v1/vault/requests/inspect", {
				body: { token: token.current },
				cache: "no-store",
				referrerPolicy: "no-referrer",
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
			})
			.then(({ data, response }) => {
				if (controller.signal.aborted) return;
				if (data) {
					setContext(data);
					setRows(
						data.fields.map((name) => ({
							id: crypto.randomUUID(),
							name,
							value: "",
							required: true,
						})),
					);
					setUpdates(data.update_fields);
					setPhase("ready");
				} else if (response.status === 410 || response.status === 422) setPhase("unavailable");
				else {
					setError("Could not load this request. Try again.");
					setPhase("error");
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					setError("Could not connect. Try again.");
					setPhase("error");
				}
			});
		return () => controller.abort();
	}, [attempt]);

	function invalidateSelection() {
		selectionGeneration.current++;
		setSelectionReady(false);
		setUpdates([]);
		setSelectionError("");
		setSelectionRetryable(false);
	}

	useEffect(() => {
		if (phase !== "ready") return;
		const fields: string[] = JSON.parse(names);
		setSelectionReady(false);
		setUpdates([]);
		setSelectionError("");
		setSelectionRetryable(false);
		if (
			!fields.length ||
			fields.some((name) => !REQUEST_FIELD_NAME_RE.test(name)) ||
			new Set(fields).size !== fields.length
		) {
			setSelectionError(
				"Use valid, distinct field names (letters, numbers, dots, underscores, and hyphens).",
			);
			return;
		}
		const controller = new AbortController();
		const generation = selectionGeneration.current;
		const timer = window.setTimeout(() => {
			void client
				.POST("/v1/vault/requests/inspect", {
					body: { token: token.current, fields },
					cache: "no-store",
					referrerPolicy: "no-referrer",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
				})
				.then(({ data, response }) => {
					if (controller.signal.aborted || generation !== selectionGeneration.current) return;
					if (data) {
						setUpdates(data.update_fields);
						setSelectionReady(true);
					} else if (response.status === 410) {
						setRows([]);
						setImportText("");
						setPreview(undefined);
						token.current = "";
						setPhase("unavailable");
					} else if (response.status === 409) {
						setSelectionError(
							"Selected fields changed or are reserved. Remove added fields or ask your agent for a new link.",
						);
					} else if (response.status === 422) {
						setSelectionError(
							"Selected field names are invalid. Use distinct names and at most 32 fields.",
						);
					} else {
						setSelectionError(
							"Could not check selected fields. The server is unavailable. Try again.",
						);
						setSelectionRetryable(true);
					}
				})
				.catch(() => {
					if (controller.signal.aborted || generation !== selectionGeneration.current) return;
					setSelectionError("Could not connect to check selected fields. Try again.");
					setSelectionRetryable(true);
				});
		}, 300);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [names, phase, selectionAttempt]);

	async function previewImport() {
		setError("");
		const parsed = parseVaultRequestEnv(importText);
		if (parsed.errors.length || !parsed.entries.length) {
			setError(parsed.errors[0] ?? "Enter at least one dotenv assignment.");
			return;
		}
		const fields = [
			...new Set([...rows.map((row) => row.name), ...parsed.entries.map((entry) => entry.key)]),
		];
		if (
			fields.length > 32 ||
			new Set(rows.map((row) => row.name)).size !== rows.length ||
			fields.some((name) => !REQUEST_FIELD_NAME_RE.test(name))
		) {
			setError("Use valid, distinct field names and at most 32 fields total.");
			return;
		}
		setImportBusy(true);
		try {
			const { data, response } = await client.POST("/v1/vault/requests/inspect", {
				body: { token: token.current, fields },
				cache: "no-store",
				referrerPolicy: "no-referrer",
				signal: AbortSignal.timeout(20000),
			});
			if (!data) {
				if (response.status === 410) {
					setRows([]);
					setImportText("");
					setPreview(undefined);
					token.current = "";
					setPhase("unavailable");
				} else if (response.status === 409) {
					setError("Could not preview these fields. A selected field changed or is reserved.");
				} else if (response.status === 422) {
					setError("Selected field names are invalid. Use distinct names and at most 32 fields.");
				} else {
					setError("Could not preview these fields. The server is unavailable. Try again.");
				}
				return;
			}
			setPreview({ entries: parsed.entries, updateFields: data.update_fields });
		} catch {
			setError("Could not connect. Try previewing again.");
		} finally {
			setImportBusy(false);
		}
	}

	function applyImport() {
		if (!preview) return;
		setRows((current) => {
			const imported = new Map(preview.entries.map((entry) => [entry.key, entry.value]));
			return [
				...current.map((row) => ({ ...row, value: imported.get(row.name) ?? row.value })),
				...preview.entries
					.filter((entry) => !current.some((row) => row.name === entry.key))
					.map((entry) => ({
						id: crypto.randomUUID(),
						name: entry.key,
						value: entry.value,
						required: false,
					})),
			];
		});
		invalidateSelection();
		setSelectionAttempt((value) => value + 1);
		setPreview(undefined);
		setImportText("");
		setImportOpen(false);
	}

	async function save() {
		if (!context || phase !== "ready" || !selectionReady || importOpen) return;
		setPhase("saving");
		setError("");
		try {
			const { data, response } = await client.POST("/v1/vault/requests/supply", {
				body: {
					token: token.current,
					fields: Object.fromEntries(rows.map((row) => [row.name, row.value])),
				},
				cache: "no-store",
				referrerPolicy: "no-referrer",
				signal: AbortSignal.timeout(20000),
			});
			if (data) {
				setContext(data);
				setRows([]);
				setImportText("");
				setPreview(undefined);
				token.current = "";
				setPhase("done");
			} else if (response.status === 409) {
				setPhase("ready");
				invalidateSelection();
			} else if (response.status === 410) {
				setRows([]);
				setImportText("");
				setPreview(undefined);
				setPhase("unavailable");
			} else {
				setError("Could not save. Supply every requested field and try again.");
				setPhase("ready");
			}
		} catch {
			setError(
				"Save could not be confirmed. Ask your agent to check the request status before trying again.",
			);
			setPhase("ready");
		}
	}

	return (
		<main className="mx-auto flex min-h-dvh max-w-lg items-center px-4 py-10">
			<Card className="w-full">
				<CardHeader className="gap-5">
					<div className="flex items-center gap-2">
						<img
							src="/clawdi-logo-transparent.png"
							alt=""
							width={28}
							height={28}
							className="size-7 shrink-0 rounded-md"
						/>
						<span className="text-sm font-semibold tracking-tight">Clawdi</span>
					</div>
					<CardTitle>
						<h1 className="text-xl font-semibold tracking-tight">
							{phase === "done"
								? "Saved securely"
								: phase === "unavailable"
									? "Link unavailable"
									: "Save to Vault"}
						</h1>
					</CardTitle>
				</CardHeader>
				<CardContent>
					{phase === "loading" && <p role="status">Loading request…</p>}
					{phase === "unavailable" && (
						<p role="alert" className="text-muted-foreground">
							{UNAVAILABLE}
						</p>
					)}
					{phase === "done" && agentMessage && (
						<>
							<p role="status" className="text-muted-foreground">
								Your secrets are saved. Send this message to your agent to continue.
							</p>
							<p className="select-text rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed break-words">
								{agentMessage}
							</p>
							{copyState === "error" && (
								<p role="alert" className="text-sm text-destructive">
									Could not copy. Select and copy the message above manually.
								</p>
							)}
							<div className="flex justify-end">
								<Button onClick={copyMessage} disabled={copyState === "copying"}>
									{copyState === "copied"
										? "Copied"
										: copyState === "copying"
											? "Copying…"
											: "Copy message for agent"}
								</Button>
							</div>
						</>
					)}
					{phase === "error" && (
						<>
							<p role="alert">{error}</p>
							<div className="flex justify-end">
								<Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
							</div>
						</>
					)}
					{context && (phase === "ready" || phase === "saving") && (
						<form
							className="space-y-5"
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<div className="space-y-1 border-b pb-5 text-sm">
								<p className="font-medium break-words">
									{context.vault_name} · {context.project_name}
								</p>
								{context.section && <p className="break-words">Section: {context.section}</p>}
								<p className="text-muted-foreground">
									Expires {new Date(context.expires_at).toLocaleString()}
								</p>
							</div>
							<p className="text-sm text-muted-foreground">
								Only these fields will be saved. Anyone with Vault access can use them.
							</p>
							{!!updates.length && (
								<p className="text-sm text-muted-foreground">
									Fields marked Update replace existing values when you save.
								</p>
							)}
							<fieldset
								disabled={phase === "saving" || importBusy || !!preview}
								className="space-y-5"
							>
								{rows.map(({ id, name, value, required }) => (
									<div className="space-y-2" key={id}>
										<div className="flex items-center justify-between gap-2">
											{required ? (
												<Label htmlFor={`secret-${id}`}>{name}</Label>
											) : (
												<Input
													aria-label="Field name"
													value={name}
													maxLength={200}
													required
													pattern="[A-Za-z0-9_.\-]+"
													className="font-mono"
													onChange={(event) => {
														invalidateSelection();
														setRows((current) =>
															current.map((row) =>
																row.id === id ? { ...row, name: event.target.value } : row,
															),
														);
													}}
												/>
											)}
											{!required && (
												<Button
													type="button"
													variant="ghost"
													aria-label={`Remove ${name || "field"}`}
													onClick={() => {
														invalidateSelection();
														setRows((current) => current.filter((row) => row.id !== id));
													}}
												>
													Remove
												</Button>
											)}
											{updates.includes(name) && (
												<span className="text-xs font-medium text-muted-foreground">Update</span>
											)}
										</div>
										<Textarea
											id={`secret-${id}`}
											aria-label={required ? undefined : `Value for ${name || "field"}`}
											value={value}
											required
											maxLength={65536}
											autoComplete="off"
											spellCheck={false}
											data-private="true"
											className="font-mono"
											disabled={phase === "saving"}
											onChange={(event) =>
												setRows((current) =>
													current.map((row) =>
														row.id === id ? { ...row, value: event.target.value } : row,
													),
												)
											}
										/>
									</div>
								))}

								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										disabled={rows.length >= 32 || importOpen}
										onClick={() => {
											invalidateSelection();
											setRows((current) => [
												...current,
												{ id: crypto.randomUUID(), name: "", value: "", required: false },
											]);
										}}
									>
										Add field
									</Button>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											setImportOpen(true);
											setError("");
										}}
									>
										Import .env
									</Button>
								</div>
							</fieldset>
							{importOpen && (
								<div className="space-y-3 rounded-lg border p-3">
									<p className="text-sm text-muted-foreground">
										Paste or choose a .env file. Values stay text; variables and commands are never
										expanded.
									</p>
									{!preview && (
										<>
											<Label htmlFor="env-import">Dotenv text</Label>
											<Textarea
												id="env-import"
												value={importText}
												data-private="true"
												autoComplete="off"
												spellCheck={false}
												disabled={importBusy}
												onChange={(event) => setImportText(event.target.value)}
											/>
											<Input
												type="file"
												aria-label="Choose .env file"
												disabled={importBusy}
												onChange={async (event) => {
													const file = event.target.files?.[0];
													event.target.value = "";
													if (!file) return;
													if (file.size > MAX_ENV_IMPORT_BYTES) {
														setError("Import must be at most 4 MiB.");
														return;
													}
													setImportBusy(true);
													try {
														setImportText(
															new TextDecoder("utf-8", { fatal: true }).decode(
																await file.arrayBuffer(),
															),
														);
													} catch {
														setError("Could not read a UTF-8 text file.");
													} finally {
														setImportBusy(false);
													}
												}}
											/>
											<Button type="button" disabled={importBusy} onClick={previewImport}>
												{importBusy ? "Checking…" : "Preview import"}
											</Button>
										</>
									)}
									{preview && (
										<>
											<p className="text-sm">
												Apply these values to the form, then save all fields together.
											</p>
											<ul className="space-y-2 text-sm">
												{preview.entries.map((entry) => (
													<li key={entry.key} className="break-words">
														<span className="font-mono">{entry.key}</span> —{" "}
														{rows.some((row) => row.name === entry.key && row.value)
															? "Replace entered value"
															: rows.some((row) => row.name === entry.key)
																? "Fill requested field"
																: "Add field"}
														{preview.updateFields.includes(entry.key)
															? " · Update existing Vault value on save"
															: ""}
													</li>
												))}
											</ul>
											<Button type="button" onClick={applyImport}>
												Apply import
											</Button>
										</>
									)}
									<Button
										type="button"
										variant="ghost"
										disabled={importBusy}
										onClick={() => {
											setImportOpen(false);
											setImportText("");
											setPreview(undefined);
										}}
									>
										Cancel import
									</Button>
								</div>
							)}
							{(error || selectionError) && (
								<p role="alert" className="text-sm text-destructive">
									{error || selectionError}
									{!error && selectionRetryable && (
										<Button
											type="button"
											variant="ghost"
											onClick={() => {
												invalidateSelection();
												setSelectionAttempt((value) => value + 1);
											}}
										>
											Retry check
										</Button>
									)}
								</p>
							)}
							<div className="flex justify-end">
								<Button
									type="submit"
									disabled={phase === "saving" || !selectionReady || importOpen}
								>
									{phase === "saving" ? "Saving…" : "Save secrets"}
								</Button>
							</div>
						</form>
					)}
				</CardContent>
			</Card>
		</main>
	);
}
