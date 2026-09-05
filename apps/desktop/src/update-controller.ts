import electronUpdater, { type AppUpdater } from "electron-updater";
import type { DesktopUpdatePolicy } from "./update-policy";
import {
	canCheckForDesktopUpdate,
	type DesktopUpdateEvent,
	type DesktopUpdateState,
	reduceDesktopUpdateState,
} from "./update-state";

const AUTOMATIC_CHECK_DELAY_MS = 30_000;
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const { autoUpdater } = electronUpdater;

export interface DesktopUpdateControllerOptions {
	policy: DesktopUpdatePolicy;
	onStateChange: (state: DesktopUpdateState) => void;
	onUpdateReady: (version: string) => void;
	updater?: AppUpdater;
}

export class DesktopUpdateController {
	private readonly updater: AppUpdater;
	private state: DesktopUpdateState;
	private initialCheck: ReturnType<typeof setTimeout> | null = null;
	private periodicCheck: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly options: DesktopUpdateControllerOptions) {
		this.updater = options.updater ?? autoUpdater;
		this.state = options.policy.enabled
			? { status: "idle" }
			: { status: "disabled", reason: options.policy.reason };
		this.options.onStateChange(this.state);
	}

	start(): void {
		if (!this.options.policy.enabled) return;
		this.updater.setFeedURL({ provider: "generic", url: this.options.policy.feedUrl });
		this.updater.autoDownload = true;
		this.updater.autoInstallOnAppQuit = false;
		this.updater.autoRunAppAfterInstall = false;
		this.updater.allowPrerelease = false;
		this.updater.on("checking-for-update", () => this.transition({ type: "check" }));
		this.updater.on("update-available", (info) =>
			this.transition({ type: "available", version: info.version }),
		);
		this.updater.on("download-progress", (info) =>
			this.transition({ type: "progress", percent: info.percent }),
		);
		this.updater.on("update-not-available", () => this.transition({ type: "not-available" }));
		this.updater.on("update-downloaded", (event) => {
			this.transition({ type: "downloaded", version: event.version });
			this.options.onUpdateReady(event.version);
		});
		this.updater.on("error", (error) => {
			console.error("Desktop update failed", error);
			this.transition({ type: "error" });
		});
		this.initialCheck = setTimeout(() => {
			this.initialCheck = null;
			void this.checkForUpdates();
		}, AUTOMATIC_CHECK_DELAY_MS);
		this.initialCheck.unref();
		this.periodicCheck = setInterval(
			() => void this.checkForUpdates(),
			AUTOMATIC_CHECK_INTERVAL_MS,
		);
		this.periodicCheck.unref();
	}

	getState(): DesktopUpdateState {
		return this.state;
	}

	async checkForUpdates(): Promise<void> {
		if (!this.options.policy.enabled || !canCheckForDesktopUpdate(this.state)) return;
		try {
			await this.updater.checkForUpdates();
		} catch (error) {
			if (this.state.status !== "error") {
				console.error("Could not check for Desktop updates", error);
				this.transition({ type: "error" });
			}
		}
	}

	installDownloadedUpdate(): boolean {
		if (this.state.status !== "ready") return false;
		this.updater.autoRunAppAfterInstall = true;
		this.updater.quitAndInstall(false, true);
		return true;
	}

	stop(): void {
		if (this.initialCheck) clearTimeout(this.initialCheck);
		if (this.periodicCheck) clearInterval(this.periodicCheck);
		this.initialCheck = null;
		this.periodicCheck = null;
	}

	private transition(event: DesktopUpdateEvent): void {
		const next = reduceDesktopUpdateState(this.state, event);
		if (next === this.state) return;
		this.state = next;
		this.options.onStateChange(next);
	}
}
