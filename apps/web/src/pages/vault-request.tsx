import type { components, paths } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { env } from "@/lib/env";

type RequestContext = components["schemas"]["VaultSecretRequestStatus"];
const client = createClient<paths>({ baseUrl: env.VITE_CLAWDI_API_URL });
const UNAVAILABLE =
	"This request has changed or its link has expired. Ask your agent for a new link.";

export function VaultRequestPage() {
	const token = useRef("");
	const [context, setContext] = useState<RequestContext>();
	const [values, setValues] = useState<Record<string, string>>({});
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
		if (!/^[A-Za-z0-9_-]{43}$/.test(token.current)) {
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

	async function save() {
		if (!context || phase !== "ready") return;
		setPhase("saving");
		setError("");
		try {
			const { data, response } = await client.POST("/v1/vault/requests/supply", {
				body: { token: token.current, fields: values },
				cache: "no-store",
				referrerPolicy: "no-referrer",
				signal: AbortSignal.timeout(20000),
			});
			if (data) {
				setContext(data);
				setValues({});
				token.current = "";
				setPhase("done");
			} else if (response.status === 410 || response.status === 409) {
				setValues({});
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
							{!!context.update_fields?.length && (
								<p className="text-sm text-muted-foreground">
									Existing values stay active until you save. They are never shown here.
								</p>
							)}
							{context.fields.map((name) => (
								<div className="space-y-2" key={name}>
									<div className="flex items-center justify-between gap-2">
										<Label htmlFor={`secret-${name}`}>{name}</Label>
										{context.update_fields?.includes(name) && (
											<span className="text-xs font-medium text-muted-foreground">Update</span>
										)}
									</div>
									<Textarea
										id={`secret-${name}`}
										value={values[name] ?? ""}
										required
										maxLength={65536}
										autoComplete="off"
										spellCheck={false}
										data-private="true"
										className="font-mono"
										disabled={phase === "saving"}
										onChange={(event) =>
											setValues((current) => ({ ...current, [name]: event.target.value }))
										}
									/>
								</div>
							))}
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
							<div className="flex justify-end">
								<Button type="submit" disabled={phase === "saving"}>
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
