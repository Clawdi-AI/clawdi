interface ParsedSemver {
	major: string;
	minor: string;
	patch: string;
	pre: string[];
}

const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_IDENTIFIER_RE = /^\d+$/;
const IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;

export function isValidSemver(value: string): boolean {
	return parseSemver(value) !== null;
}

export function compareSemver(a: string, b: string): number {
	const left = parseSemver(a);
	const right = parseSemver(b);
	if (!left || !right) {
		throw new Error(`invalid semver comparison: ${a} <=> ${b}`);
	}
	for (const key of ["major", "minor", "patch"] as const) {
		const compared = compareNumericIdentifier(left[key], right[key]);
		if (compared !== 0) return compared;
	}
	if (left.pre.length === 0 && right.pre.length === 0) return 0;
	if (left.pre.length === 0) return 1;
	if (right.pre.length === 0) return -1;
	const length = Math.max(left.pre.length, right.pre.length);
	for (let i = 0; i < length; i++) {
		const l = left.pre[i];
		const r = right.pre[i];
		if (l === undefined) return -1;
		if (r === undefined) return 1;
		if (l === r) continue;
		const lNumeric = NUMERIC_IDENTIFIER_RE.test(l);
		const rNumeric = NUMERIC_IDENTIFIER_RE.test(r);
		if (lNumeric && rNumeric) return compareNumericIdentifier(l, r);
		if (lNumeric) return -1;
		if (rNumeric) return 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

export function isSemverLessThan(a: string, b: string): boolean {
	return compareSemver(a, b) < 0;
}

function parseSemver(value: string): ParsedSemver | null {
	const match = SEMVER_RE.exec(value);
	if (!match) return null;
	const [, major, minor, patch, pre] = match;
	if (!major || !minor || !patch) return null;
	const prerelease = pre ? pre.split(".") : [];
	const build = value.includes("+") ? value.slice(value.indexOf("+") + 1).split(".") : [];
	if (![...prerelease, ...build].every((part) => IDENTIFIER_RE.test(part))) return null;
	if (
		prerelease.some(
			(part) => NUMERIC_IDENTIFIER_RE.test(part) && part.length > 1 && part.startsWith("0"),
		)
	) {
		return null;
	}
	return {
		major,
		minor,
		patch,
		pre: prerelease,
	};
}

function compareNumericIdentifier(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
