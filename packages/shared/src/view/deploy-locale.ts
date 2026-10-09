import {
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeployLanguage,
	normalizeHostedDeployLanguage,
} from "../api/deploy-wizard";

/**
 * Best-effort map of preferred locales (browser `navigator.languages`, or the
 * device locale from `Intl`) onto the curated hosted language contract.
 */
export function hostedDeployLanguageFromLocales(
	preferred: readonly string[],
): HostedDeployLanguage | "" {
	for (const raw of preferred) {
		if (!raw) continue;
		const exact = normalizeHostedDeployLanguage(raw);
		if (exact) return exact;
		const base = raw.toLowerCase().split("-")[0];
		const byBase = HOSTED_DEPLOY_LANGUAGE_OPTIONS.find(
			(option) => option.code.toLowerCase().split("-")[0] === base,
		);
		if (byBase) return byBase.code;
	}
	return "";
}

const FALLBACK_TIMEZONES = [
	"UTC",
	"Africa/Johannesburg",
	"America/Chicago",
	"America/Los_Angeles",
	"America/New_York",
	"America/Sao_Paulo",
	"Asia/Dubai",
	"Asia/Hong_Kong",
	"Asia/Kolkata",
	"Asia/Shanghai",
	"Asia/Singapore",
	"Asia/Tokyo",
	"Australia/Sydney",
	"Europe/Berlin",
	"Europe/London",
	"Pacific/Auckland",
] as const;

function timezoneSort(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function isValidTimezone(value: string | null | undefined): value is string {
	if (!value) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
		return true;
	} catch {
		return false;
	}
}

function runtimeTimezones(): readonly string[] | null {
	const intl = Intl as typeof Intl & {
		supportedValuesOf?: (key: "timeZone") => string[];
	};
	if (typeof intl.supportedValuesOf !== "function") return null;
	try {
		return intl.supportedValuesOf("timeZone");
	} catch {
		return null;
	}
}

function validatedTimezones(values: readonly string[]): string[] {
	return [...new Set(values.filter(isValidTimezone))].sort(timezoneSort);
}

/**
 * Runtime IANA data with a standards-valid fallback. Passing `null` explicitly
 * exercises the fallback path; additional valid values preserve device or
 * persisted choices omitted by a runtime's enumeration. A runtime (or polyfill)
 * that enumerates nothing valid also falls back, so the picker never offers UTC alone.
 */
export function supportedTimezones(
	additional: readonly string[] = [],
	runtimeValues: readonly string[] | null = runtimeTimezones(),
): string[] {
	const runtime = runtimeValues ? validatedTimezones(runtimeValues) : [];
	return validatedTimezones([
		...(runtime.length ? runtime : FALLBACK_TIMEZONES),
		"UTC",
		...additional,
	]);
}

/** Stable initial options for SSR and the first client render. */
export function fallbackTimezones(additional: readonly string[] = []): string[] {
	return supportedTimezones(additional, null);
}

/** The runtime's resolved IANA timezone, or "" when it reports none or an invalid one. */
export function resolvedTimezone(): string {
	try {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
		return isValidTimezone(timezone) ? timezone : "";
	} catch {
		return "";
	}
}

/** The runtime's resolved locale tag, or "" when unavailable. */
export function resolvedLocale(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale || "";
	} catch {
		return "";
	}
}

export function mergeTimezoneOptions(
	options: readonly string[],
	additional: readonly string[],
): string[] {
	return validatedTimezones([...options, ...additional]);
}

export function timezoneLabel(timezone: string): string {
	return timezone.replaceAll("_", " ");
}
