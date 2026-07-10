interface ParsedSemver {
	major: number;
	minor: number;
	patch: number;
	pre: string[];
}

const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

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
		if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
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
		const lNum = numericIdentifier(l);
		const rNum = numericIdentifier(r);
		if (lNum !== null && rNum !== null) return lNum < rNum ? -1 : 1;
		if (lNum !== null) return -1;
		if (rNum !== null) return 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

export function isSemverLessThan(a: string, b: string): boolean {
	return compareSemver(a, b) < 0;
}

function parseSemver(value: string): ParsedSemver | null {
	const match = SEMVER_RE.exec(value.trim());
	if (!match) return null;
	const [, major, minor, patch, pre] = match;
	if (!major || !minor || !patch) return null;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		pre: pre ? pre.split(".") : [],
	};
}

function numericIdentifier(value: string): number | null {
	if (!/^(0|[1-9]\d*)$/.test(value)) return null;
	return Number.parseInt(value, 10);
}
