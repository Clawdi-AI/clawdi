import type { DesktopUpdateSkipReason } from "./update-policy";

export type DesktopUpdateState =
	| { status: "disabled"; reason: DesktopUpdateSkipReason }
	| { status: "idle" }
	| { status: "checking" }
	| { status: "downloading"; version: string; percent: number | null }
	| { status: "ready"; version: string }
	| { status: "error" };

export type DesktopUpdateEvent =
	| { type: "check" }
	| { type: "available"; version: string }
	| { type: "progress"; percent: number }
	| { type: "downloaded"; version: string }
	| { type: "not-available" }
	| { type: "error" };

export function reduceDesktopUpdateState(
	state: DesktopUpdateState,
	event: DesktopUpdateEvent,
): DesktopUpdateState {
	if (state.status === "disabled") return state;
	switch (event.type) {
		case "check":
			return canCheckForDesktopUpdate(state) ? { status: "checking" } : state;
		case "available":
			return state.status === "checking"
				? { status: "downloading", version: event.version, percent: null }
				: state;
		case "progress":
			return state.status === "downloading"
				? { ...state, percent: clampPercent(event.percent) }
				: state;
		case "downloaded":
			return state.status === "downloading" ? { status: "ready", version: event.version } : state;
		case "not-available":
			return state.status === "checking" ? { status: "idle" } : state;
		case "error":
			return state.status === "ready" || state.status === "error" ? state : { status: "error" };
	}
}

export function canCheckForDesktopUpdate(state: DesktopUpdateState): boolean {
	return state.status === "idle" || state.status === "error";
}

export function desktopUpdateStatusLabel(state: DesktopUpdateState): string | null {
	switch (state.status) {
		case "disabled":
		case "idle":
			return null;
		case "checking":
			return "Checking for Updates…";
		case "downloading":
			return state.percent === null
				? `Downloading Clawdi ${state.version}…`
				: `Downloading Clawdi ${state.version}… ${Math.round(state.percent)}%`;
		case "ready":
			return `Clawdi ${state.version} is ready to install`;
		case "error":
			return "Update Check Failed";
	}
}

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.min(100, Math.max(0, percent));
}
