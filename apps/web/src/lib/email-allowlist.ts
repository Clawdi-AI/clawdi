/**
 * Email-domain allowlist for the dashboard. Comma-separated
 * `ALLOWED_EMAIL_DOMAINS` drives it; unset or empty means "no restriction".
 *
 *   ALLOWED_EMAIL_DOMAINS=example.com,another.org
 *
 * Kept here as a pure function (no Clerk imports) so tests can exercise
 * it without mocking the auth stack.
 */

function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((d) => d.trim().toLowerCase())
			.filter(Boolean),
	);
}

const ALLOWED_DOMAINS = parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS);

/**
 * Return true when the given email (primary email from Clerk) is allowed
 * into the dashboard. Falsy emails are rejected — we never want an
 * unverified or missing address sliding past the gate. When the allowlist
 * is empty we pass everyone through so local dev doesn't need the var.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
	if (ALLOWED_DOMAINS.size === 0) return true;
	if (!email) return false;
	const at = email.lastIndexOf("@");
	if (at < 0) return false;
	const domain = email.slice(at + 1).toLowerCase();
	return ALLOWED_DOMAINS.has(domain);
}

export function allowlistIsActive(): boolean {
	return ALLOWED_DOMAINS.size > 0;
}
