"use client";

import type { AiProviderUpsert } from "@/hosted/v2/ai-providers/types";

/**
 * Codex "Sign in with ChatGPT" OAuth — v2 parity with the monorepo v1 flow
 * (lib/cloud-ai-providers.ts). The canonical provider id is `openai-codex`;
 * a successful sign-in lands `auth: {type:"agent_profile", tool:"codex",
 * profile}` (NOT oauth_profile).
 *
 * Flow: create the openai-codex provider → POST .../auth/oauth/start
 * {provider:"codex", redirect_uri} → open auth_url (ChatGPT) → the v2 callback
 * route captures code+state → POST .../auth/oauth/complete {code, state,
 * redirect_uri}. The redirect_uri is the SAME app callback route across
 * start + complete + the callback page.
 */

export const CLAWDI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";

/** Cross-window channel + storage key the callback uses to hand back code+state. */
export const CODEX_OAUTH_CHANNEL = "clawdi-codex-oauth";
export const CODEX_OAUTH_STORAGE_KEY = "clawdi:codex-oauth-result";

export interface CodexOAuthResult {
	code: string;
	state: string;
	error?: string;
}

/** The v2 app's own OAuth callback route — the redirect_uri the flow uses. */
export function codexRedirectUri(): string {
	if (typeof window === "undefined") return "";
	return `${window.location.origin}/oauth/codex/callback`;
}

/** Default model shown for a fresh Codex provider (OpenAI Responses / GPT-5). */
export const CODEX_DEFAULT_MODEL = "gpt-5";

/** Upsert body for the canonical Codex provider (pre-sign-in placeholder auth). */
export function codexProviderBody(defaultModel?: string): AiProviderUpsert {
	return {
		provider_id: CLAWDI_CODEX_OAUTH_PROVIDER_ID,
		type: "openai",
		label: "Codex (ChatGPT)",
		base_url: "https://api.openai.com/v1",
		default_model: defaultModel?.trim() || CODEX_DEFAULT_MODEL,
		api_mode: "openai_responses",
		auth: { type: "agent_profile", tool: "codex", profile: "default" },
		managed_by: "user",
		runtime_env_name: null,
	};
}

/**
 * Parse a pasted OAuth callback URL (or raw `?code=…&state=…` query) — the
 * manual completion path for when the redirect can't reach the app automatically
 * (e.g. the backend hasn't whitelisted the app redirect_uri yet).
 */
export function parseCodexCallback(input: string): CodexOAuthResult | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let search = "";
	let hash = "";
	try {
		const url = new URL(trimmed);
		search = url.search;
		hash = url.hash.replace(/^#/, "");
	} catch {
		// Not a full URL — treat the whole string as a query fragment.
		search = trimmed.replace(/^[?#]/, "");
	}
	const q = new URLSearchParams(search);
	const h = new URLSearchParams(hash);
	const code = q.get("code") || h.get("code") || "";
	const state = q.get("state") || h.get("state") || "";
	const error = q.get("error") || h.get("error") || undefined;
	if (error) return { code: "", state: "", error };
	if (!code || !state) return null;
	return { code, state };
}
