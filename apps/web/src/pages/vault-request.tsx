import type { components, paths } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { env } from "@/lib/env";

type RequestContext = components["schemas"]["VaultSecretRequestStatus"];
const client = createClient<paths>({ baseUrl: env.VITE_CLAWDI_API_URL });
const UNAVAILABLE =
	"This link has expired, was already used, or is no longer available. Ask your agent for a new request.";

export function VaultRequestPage() {
	const token = useRef("");
	const [context, setContext] = useState<RequestContext>();
	const [values, setValues] = useState<Record<string, string>>({});
	const [phase, setPhase] = useState<
		"loading" | "ready" | "saving" | "done" | "unavailable" | "error"
	>("loading");
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);

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
		<main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-12">
			<Card className="w-full">
				<CardHeader>
					<CardTitle>Supply Vault secrets</CardTitle>
					<CardDescription>
						Save credentials directly to Clawdi Vault without putting them in chat.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					{phase === "loading" && <p role="status">Loading request…</p>}
					{phase === "unavailable" && <p role="alert">{UNAVAILABLE}</p>}
					{phase === "done" && (
						<p role="status">
							Saved securely. This link is now used. Your agent can read the supplied fields. You
							can close this page.
						</p>
					)}
					{phase === "error" && (
						<>
							<p role="alert">{error}</p>
							<Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
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
							<div className="rounded-lg bg-muted p-3 text-sm">
								<p className="font-medium">
									{context.vault_name} · {context.project_name}
								</p>
								{context.section && <p>Section: {context.section}</p>}
								<p className="text-muted-foreground">
									Expires {new Date(context.expires_at).toLocaleString()}
								</p>
							</div>
							<p className="text-sm text-muted-foreground">
								Only these fields will be added. Anyone with access to this Vault can use the saved
								credentials.
							</p>
							{context.fields.map((name) => (
								<div className="space-y-2" key={name}>
									<Label htmlFor={`secret-${name}`}>{name}</Label>
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
							<Button type="submit" disabled={phase === "saving"}>
								{phase === "saving" ? "Saving…" : "Save secrets"}
							</Button>
						</form>
					)}
				</CardContent>
			</Card>
		</main>
	);
}
