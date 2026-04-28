/**
 * Email-domain allowlist for the dashboard. Comma-separated
 * `ALLOWED_EMAIL_DOMAINS` drives it; unset or empty means "no restriction".
 *
 *   ALLOWED_EMAIL_DOMAINS=example.com,another.org
 *
 * Splitting + normalization happens inside the env schema
 * (`lib/env.ts`), which already exposes `ALLOWED_EMAIL_DOMAINS` as a
 * normalized `string[]`. This module just consumes it.
 */

import { env } from "@/lib/env";

/**
 * Return true when the given email (primary email from Clerk) is allowed
 * into the dashboard. Falsy emails are rejected — we never want an
 * unverified or missing address sliding past the gate. When the allowlist
 * is empty we pass everyone through so local dev doesn't need the var.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
	if (env.ALLOWED_EMAIL_DOMAINS.length === 0) return true;
	if (!email) return false;
	const at = email.lastIndexOf("@");
	if (at < 0) return false;
	const domain = email.slice(at + 1).toLowerCase();
	return env.ALLOWED_EMAIL_DOMAINS.includes(domain);
}

export function allowlistIsActive(): boolean {
	return env.ALLOWED_EMAIL_DOMAINS.length > 0;
}
