import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentType } from "../adapters/agent-types";
import type { SessionUserActivity } from "../adapters/base";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { RECENT_USER_INPUT_WINDOW_MS } from "../lib/session-activity";
import { getServeStateDir } from "../serve/paths";

export const RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION = 2;

type SupportedRuntime = "hermes" | "openclaw";

export interface RuntimeUserActivityState {
	schemaVersion: "clawdi.runtimeUserActivity.v1";
	agentType: SupportedRuntime;
	classifierVersion: typeof RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION;
	classification: "known_last_user_input" | "known_no_user_input" | "unknown";
	lastUserInputAt: string | null;
	recentUserInputCount: number | null;
	observedAt: string;
	completeAt: string | null;
	error?: string;
}

export function supportsRuntimeUserActivity(agentType: AgentType): agentType is SupportedRuntime {
	return agentType === "hermes" || agentType === "openclaw";
}

export function runtimeUserActivityStatePath(agentType: SupportedRuntime): string {
	return join(getServeStateDir(agentType), "user-activity.json");
}

export function readRuntimeUserActivityState(path: string): RuntimeUserActivityState | null {
	try {
		const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const row = value as Record<string, unknown>;
		if (
			row.schemaVersion !== "clawdi.runtimeUserActivity.v1" ||
			!isSupportedRuntime(row.agentType) ||
			row.classifierVersion !== RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION ||
			!isClassification(row.classification) ||
			!isIsoTimestamp(row.observedAt) ||
			!(row.completeAt === null || isIsoTimestamp(row.completeAt)) ||
			!(row.lastUserInputAt === null || isIsoTimestamp(row.lastUserInputAt)) ||
			!(row.recentUserInputCount === null || isUserInputCount(row.recentUserInputCount)) ||
			!(row.error === undefined || typeof row.error === "string")
		) {
			return null;
		}
		if (row.classification === "known_last_user_input" && row.lastUserInputAt === null) {
			return null;
		}
		if (row.classification === "known_no_user_input" && row.lastUserInputAt !== null) return null;
		if (row.classification !== "unknown" && row.completeAt === null) return null;
		if (row.classification === "unknown" ? !row.error : row.error !== undefined) return null;
		if (row.classification === "unknown" && row.recentUserInputCount !== null) return null;
		const observedAt = new Date(row.observedAt).getTime();
		if (row.completeAt !== null && new Date(row.completeAt).getTime() > observedAt) return null;
		if (row.lastUserInputAt !== null && new Date(row.lastUserInputAt).getTime() > observedAt)
			return null;
		return {
			schemaVersion: "clawdi.runtimeUserActivity.v1",
			agentType: row.agentType,
			classifierVersion: RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION,
			classification: row.classification,
			lastUserInputAt: row.lastUserInputAt,
			recentUserInputCount: row.recentUserInputCount,
			observedAt: row.observedAt,
			completeAt: row.completeAt,
			...(typeof row.error === "string" ? { error: row.error } : {}),
		};
	} catch {
		return null;
	}
}

export function runtimeUserActivityNeedsMaterialization(agentType: AgentType): boolean {
	if (!supportsRuntimeUserActivity(agentType)) return false;
	const state = readRuntimeUserActivityState(runtimeUserActivityStatePath(agentType));
	return (
		state === null ||
		state.agentType !== agentType ||
		state.classification === "unknown" ||
		state.completeAt === null
	);
}

export function recordRuntimeUserActivityScan(input: {
	agentType: AgentType;
	userActivity: SessionUserActivity;
	complete: boolean;
	materialize?: boolean;
	refresh?: boolean;
	observedAt?: Date;
}): void {
	if (!supportsRuntimeUserActivity(input.agentType)) return;
	const path = runtimeUserActivityStatePath(input.agentType);
	const stored = readRuntimeUserActivityState(path);
	const previous = stored?.agentType === input.agentType ? stored : null;
	const observationTime = input.observedAt ?? new Date();
	const observedAtMs = observationTime.getTime();
	const observedAt = observationTime.toISOString();
	if (previous && observedAtMs < Date.parse(previous.observedAt)) return;
	const scanLatest = maxTimestamp(input.userActivity.lastUserInputAt);
	const previousLatest = maxTimestamp(previous?.lastUserInputAt ?? null);
	const latest = maxTimestamp(previousLatest, scanLatest);
	const priorBaselineKnown =
		previous !== null && previous.classification !== "unknown" && previous.completeAt !== null;
	const known = input.userActivity.complete && (input.complete || priorBaselineKnown);
	const timestampIsValid = latest === null || Date.parse(latest) <= observedAtMs;
	const count = input.userActivity.recentUserInputCount;
	if (input.refresh && priorBaselineKnown && (!input.complete || !known || !timestampIsValid)) {
		writeState(path, { ...previous, recentUserInputCount: null });
		return;
	}
	// An incremental scan can retain the previous snapshot when it adds no newer evidence.
	if (
		known &&
		priorBaselineKnown &&
		!input.materialize &&
		count === null &&
		previous.recentUserInputCount !== null &&
		latest === previousLatest
	)
		return;
	// A retained message inside this window may be absent from the newly scanned sources.
	const retainedRecentInput =
		latest !== null &&
		latest !== scanLatest &&
		Date.parse(latest) >= observedAtMs - RECENT_USER_INPUT_WINDOW_MS;
	writeState(path, {
		schemaVersion: "clawdi.runtimeUserActivity.v1",
		agentType: input.agentType,
		classifierVersion: RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION,
		classification:
			known && timestampIsValid
				? latest
					? "known_last_user_input"
					: "known_no_user_input"
				: "unknown",
		lastUserInputAt: timestampIsValid ? latest : (previous?.lastUserInputAt ?? null),
		recentUserInputCount: known && timestampIsValid && !retainedRecentInput ? count : null,
		observedAt,
		completeAt: known && timestampIsValid ? observedAt : (previous?.completeAt ?? null),
		...(known && timestampIsValid
			? {}
			: {
					error: timestampIsValid ? "activity_scan_incomplete" : "activity_timestamp_in_future",
				}),
	});
}

export function markRuntimeUserActivityUnknown(
	agentType: AgentType,
	error = "activity_scan_failed",
	preserveBaseline = false,
): void {
	if (!supportsRuntimeUserActivity(agentType)) return;
	const path = runtimeUserActivityStatePath(agentType);
	const stored = readRuntimeUserActivityState(path);
	const previous = stored?.agentType === agentType ? stored : null;
	if (preserveBaseline && previous && previous.classification !== "unknown") {
		writeState(path, { ...previous, recentUserInputCount: null });
		return;
	}
	const failedAt = new Date().toISOString();
	writeState(path, {
		schemaVersion: "clawdi.runtimeUserActivity.v1",
		agentType,
		classifierVersion: RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION,
		classification: "unknown",
		lastUserInputAt: previous?.lastUserInputAt ?? null,
		recentUserInputCount: null,
		observedAt: maxTimestamp(previous?.observedAt ?? null, failedAt) ?? failedAt,
		completeAt: previous?.completeAt ?? null,
		error,
	});
}

function writeState(path: string, state: RuntimeUserActivityState): void {
	writePrivateFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

function isSupportedRuntime(value: unknown): value is SupportedRuntime {
	return value === "hermes" || value === "openclaw";
}

function isClassification(value: unknown): value is RuntimeUserActivityState["classification"] {
	return (
		value === "known_last_user_input" || value === "known_no_user_input" || value === "unknown"
	);
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isUserInputCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function maxTimestamp(...values: Array<string | null>): string | null {
	let best: number | null = null;
	for (const value of values) {
		if (!value) continue;
		const timestamp = new Date(value).getTime();
		if (!Number.isNaN(timestamp) && (best === null || timestamp > best)) best = timestamp;
	}
	return best === null ? null : new Date(best).toISOString();
}
