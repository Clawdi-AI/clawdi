import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentType } from "../adapters/agent-types";
import type { RawSession } from "../adapters/base";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { getServeStateDir } from "../serve/paths";

export const RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION = 1;

export interface RuntimeUserActivityState {
	schemaVersion: "clawdi.runtimeUserActivity.v1";
	agentType: "openclaw";
	classifierVersion: 1;
	classification: "known_last_user_input" | "known_no_user_input" | "unknown";
	lastUserInputAt: string | null;
	observedAt: string;
	completeAt: string | null;
	error?: string;
}

export function supportsRuntimeUserActivity(agentType: AgentType): agentType is "openclaw" {
	return agentType === "openclaw";
}

export function runtimeUserActivityStatePath(agentType: "openclaw"): string {
	return join(getServeStateDir(agentType), "user-activity.json");
}

export function readRuntimeUserActivityState(path: string): RuntimeUserActivityState | null {
	try {
		const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const row = value as Record<string, unknown>;
		if (
			row.schemaVersion !== "clawdi.runtimeUserActivity.v1" ||
			row.agentType !== "openclaw" ||
			row.classifierVersion !== RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION ||
			!isClassification(row.classification) ||
			!isIsoTimestamp(row.observedAt) ||
			!(row.completeAt === null || isIsoTimestamp(row.completeAt)) ||
			!(row.lastUserInputAt === null || isIsoTimestamp(row.lastUserInputAt)) ||
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
		const observedAt = new Date(row.observedAt).getTime();
		if (row.completeAt !== null && new Date(row.completeAt).getTime() > observedAt) return null;
		if (row.lastUserInputAt !== null && new Date(row.lastUserInputAt).getTime() > observedAt)
			return null;
		return {
			schemaVersion: "clawdi.runtimeUserActivity.v1",
			agentType: "openclaw",
			classifierVersion: RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION,
			classification: row.classification,
			lastUserInputAt: row.lastUserInputAt,
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
	return state === null || state.classification === "unknown" || state.completeAt === null;
}

export function recordRuntimeUserActivityScan(input: {
	agentType: AgentType;
	sessions: readonly RawSession[];
	complete: boolean;
	activityComplete: boolean;
	observedAt?: Date;
}): void {
	if (!supportsRuntimeUserActivity(input.agentType)) return;
	const path = runtimeUserActivityStatePath(input.agentType);
	const previous = readRuntimeUserActivityState(path);
	const observedAt = maxTimestamp(
		previous?.observedAt ?? null,
		(input.observedAt ?? new Date()).toISOString(),
	) as string;
	const latest = maxTimestamp(
		previous?.lastUserInputAt ?? null,
		...input.sessions.map((session) => session.realUserInputAt ?? null),
	);
	const priorBaselineKnown =
		previous !== null && previous.classification !== "unknown" && previous.completeAt !== null;
	const known = input.activityComplete && (input.complete || priorBaselineKnown);
	const timestampIsValid =
		latest === null || new Date(latest).getTime() <= new Date(observedAt).getTime();
	const completeAt = known && timestampIsValid ? observedAt : (previous?.completeAt ?? null);
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
		observedAt,
		completeAt,
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
): void {
	if (!supportsRuntimeUserActivity(agentType)) return;
	const path = runtimeUserActivityStatePath(agentType);
	const previous = readRuntimeUserActivityState(path);
	writeState(path, {
		schemaVersion: "clawdi.runtimeUserActivity.v1",
		agentType,
		classifierVersion: RUNTIME_USER_ACTIVITY_CLASSIFIER_VERSION,
		classification: "unknown",
		lastUserInputAt: previous?.lastUserInputAt ?? null,
		observedAt: new Date().toISOString(),
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

function isClassification(value: unknown): value is RuntimeUserActivityState["classification"] {
	return (
		value === "known_last_user_input" || value === "known_no_user_input" || value === "unknown"
	);
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
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
