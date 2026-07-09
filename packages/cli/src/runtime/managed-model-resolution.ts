export interface ManagedPrimaryModelResolutionInput {
	seedModel: string | null;
	liveModelIds: readonly string[] | null;
}

export interface ManagedPrimaryModelResolution {
	resolvedModel: string | null;
	reason:
		| "kept_valid_seed"
		| "upgraded_to_latest"
		| "kept_seed_after_fetch_failure"
		| "kept_seed_without_live_models"
		| "no_candidate_model";
}

export function buildManagedModelsEndpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function extractManagedLiveModelIds(payload: unknown): string[] {
	if (!isPlainRecord(payload) || !Array.isArray(payload.data)) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of payload.data) {
		if (!isPlainRecord(entry)) continue;
		const id = normalizeModelId(entry.id);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

export function resolveManagedPrimaryModel(
	input: ManagedPrimaryModelResolutionInput,
): ManagedPrimaryModelResolution {
	const seedModel = normalizeModelId(input.seedModel);
	if (input.liveModelIds === null) {
		return {
			resolvedModel: seedModel,
			reason: seedModel ? "kept_seed_after_fetch_failure" : "no_candidate_model",
		};
	}

	const liveModelIds = dedupeModelIds(input.liveModelIds);
	if (seedModel && liveModelIds.includes(seedModel)) {
		return { resolvedModel: seedModel, reason: "kept_valid_seed" };
	}

	const preferredPrefix = seedModel ? inferManagedModelFamilyPrefix(seedModel) : null;
	const latestModel = pickLatestManagedModel(liveModelIds, preferredPrefix);
	if (latestModel) {
		return { resolvedModel: latestModel, reason: "upgraded_to_latest" };
	}

	if (seedModel) {
		return { resolvedModel: seedModel, reason: "kept_seed_without_live_models" };
	}
	return { resolvedModel: null, reason: "no_candidate_model" };
}

export function pickLatestManagedModel(
	modelIds: readonly string[],
	preferredPrefix?: string | null,
): string | null {
	const normalized = dedupeModelIds(modelIds);
	if (normalized.length === 0) return null;
	const prefix = normalizeSortPrefix(preferredPrefix);
	const preferred =
		prefix === null
			? normalized
			: normalized.filter((modelId) => inferManagedModelFamilyPrefix(modelId) === prefix);
	const candidates = preferred.length > 0 ? preferred : normalized;
	const sorted = [...candidates].sort(compareManagedModelIds);
	return sorted[0] ?? null;
}

function compareManagedModelIds(left: string, right: string): number {
	const leftPrefix = inferManagedModelFamilyPrefix(left);
	const rightPrefix = inferManagedModelFamilyPrefix(right);
	const byKey = compareSortKeys(
		managedModelSortKey(left, leftPrefix),
		managedModelSortKey(right, rightPrefix),
	);
	if (byKey !== 0) return byKey;
	const byPrefix = leftPrefix.localeCompare(rightPrefix);
	if (byPrefix !== 0) return byPrefix;
	return left.localeCompare(right);
}

function managedModelSortKey(modelId: string, prefix: string): Array<number | string> {
	let rest = modelId.slice(prefix.length);
	if (rest.startsWith("/")) rest = rest.slice(1);
	rest = rest.replace(/^-+/, "").trim();

	const nums: number[] = [];
	let suffix = "";
	let state: "start" | "in_version" | "between" | "in_suffix" = "start";
	let numBuf = "";

	for (const ch of rest) {
		if (state === "start") {
			if (ch === "v" || ch === "V") {
				state = "in_version";
				continue;
			}
			if (isAsciiDigit(ch)) {
				state = "in_version";
				numBuf += ch;
				continue;
			}
			if (ch === "-" || ch === "_" || ch === ".") continue;
			state = "in_suffix";
			suffix += ch;
			continue;
		}
		if (state === "in_version") {
			if (isAsciiDigit(ch)) {
				numBuf += ch;
				continue;
			}
			if (ch === ".") {
				if (numBuf.includes(".")) {
					pushParsedNumber(nums, numBuf);
					numBuf = "";
				} else {
					numBuf += ch;
				}
				continue;
			}
			if (ch === "-" || ch === "_" || ch === ".") {
				pushParsedNumber(nums, numBuf);
				numBuf = "";
				state = "between";
				continue;
			}
			pushParsedNumber(nums, numBuf);
			numBuf = "";
			state = "in_suffix";
			suffix += ch;
			continue;
		}
		if (state === "between") {
			if (isAsciiDigit(ch)) {
				state = "in_version";
				numBuf = ch;
				continue;
			}
			if (ch === "v" || ch === "V") {
				state = "in_version";
				continue;
			}
			if (ch === "-" || ch === "_" || ch === ".") continue;
			state = "in_suffix";
			suffix += ch;
			continue;
		}
		suffix += ch;
	}

	if (state === "in_version") pushParsedNumber(nums, numBuf);

	const versionKey = nums.map((value) => -value);
	const normalizedSuffix = suffix
		.toLowerCase()
		.replace(/^[-_.]+|[-_.]+$/g, "")
		.trim();
	const suffixRank = normalizedSuffix && MANAGED_MODEL_SUFFIX_RANK[normalizedSuffix] === 0 ? 0 : 1;
	return [...versionKey, suffixRank, normalizedSuffix];
}

function compareSortKeys(
	left: readonly (number | string)[],
	right: readonly (number | string)[],
): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a === b) continue;
		if (typeof a === "number" && typeof b === "number") return a - b;
		return String(a).localeCompare(String(b));
	}
	return left.length - right.length;
}

function inferManagedModelFamilyPrefix(modelId: string): string {
	const normalized = normalizeModelId(modelId);
	if (!normalized) return "";
	const slashIndex = normalized.lastIndexOf("/");
	const scope = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : "";
	const localId = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
	const versionIndex = localId.search(/[0-9]/);
	if (versionIndex <= 0) return normalized;
	const family = localId.slice(0, versionIndex).replace(/[-_.]+$/g, "");
	return `${scope}${family || localId}`;
}

function dedupeModelIds(modelIds: readonly string[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const modelId of modelIds) {
		const normalized = normalizeModelId(modelId);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ids.push(normalized);
	}
	return ids;
}

function normalizeModelId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSortPrefix(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function pushParsedNumber(target: number[], raw: string): void {
	const trimmed = raw.replace(/\.+$/g, "");
	if (!trimmed) return;
	const parsed = Number.parseFloat(trimmed);
	if (Number.isFinite(parsed)) target.push(parsed);
}

function isAsciiDigit(value: string): boolean {
	return value >= "0" && value <= "9";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MANAGED_MODEL_SUFFIX_RANK: Record<string, 0> = {
	max: 0,
	plus: 0,
	pro: 0,
	turbo: 0,
};
