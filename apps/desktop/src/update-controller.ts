import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";
import type { DesktopUpdatePolicy } from "./update-policy";
import {
	canCheckForDesktopUpdate,
	type DesktopUpdateEvent,
	type DesktopUpdateState,
	reduceDesktopUpdateState,
} from "./update-state";

const AUTOMATIC_CHECK_DELAY_MS = 30_000;
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface DesktopUpdater
	extends Pick<
		AppUpdater,
		| "autoDownload"
		| "autoInstallOnAppQuit"
		| "autoRunAppAfterInstall"
		| "channel"
		| "allowPrerelease"
		| "allowDowngrade"
		| "checkForUpdates"
		| "quitAndInstall"
	> {
	on: (...args: Parameters<AppUpdater["on"]>) => unknown;
}

export interface DesktopUpdateControllerOptions {
	policy: DesktopUpdatePolicy;
	onStateChange: (state: DesktopUpdateState) => void;
	onUpdateReady: (version: string) => void;
	onUpdateAvailable?: (version: string) => void;
	updater: DesktopUpdater;
}

export class DesktopUpdateController {
	private readonly updater: DesktopUpdater;
	private readonly notifiedVersions = new Set<string>();
	private installing = false;
	private installError: Error | null = null;
	private state: DesktopUpdateState;
	private initialCheck: ReturnType<typeof setTimeout> | null = null;
	private periodicCheck: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly options: DesktopUpdateControllerOptions) {
		this.updater = options.updater;
		this.state =
			"channel" in options.policy
				? { status: "idle" }
				: { status: "disabled", reason: options.policy.reason };
		this.options.onStateChange(this.state);
	}

	start(): void {
		if (!("channel" in this.options.policy)) return;
		// https://www.electron.build/docs/features/auto-update/
		// DEB/RPM use checkForUpdates with autoDownload=false, never an installer.
		this.updater.autoDownload = this.options.policy.enabled;
		// Before-quit awaits the application's service shutdown. Installation on
		// quit is owned by electron-updater; its quit handler does not relaunch.
		this.updater.autoInstallOnAppQuit = this.options.policy.enabled;
		this.updater.channel = this.options.policy.channel === "stable" ? "latest" : "beta";
		this.updater.allowPrerelease = this.options.policy.channel === "beta";
		// Setting channel enables downgrades in electron-updater.
		this.updater.allowDowngrade = false;
		this.updater.on("checking-for-update", () => this.transition({ type: "check" }));
		this.updater.on("update-available", (info: UpdateInfo) => {
			this.transition({
				type: "available",
				version: info.version,
				checkOnly: !this.options.policy.enabled,
			});
			if (this.state.status === "available" && !this.notifiedVersions.has(info.version)) {
				this.notifiedVersions.add(info.version);
				this.options.onUpdateAvailable?.(info.version);
			}
		});
		this.updater.on("download-progress", (info: ProgressInfo) =>
			this.transition({ type: "progress", percent: info.percent }),
		);
		this.updater.on("update-not-available", () => this.transition({ type: "not-available" }));
		this.updater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
			if (!this.options.policy.enabled) return;
			this.transition({ type: "downloaded", version: event.version });
			if (this.state.status === "ready" && !this.notifiedVersions.has(event.version)) {
				this.notifiedVersions.add(event.version);
				this.options.onUpdateReady(event.version);
			}
		});
		this.updater.on("error", (error: Error) => {
			if (this.installing) this.installError = error;
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

	async checkForUpdates(): Promise<void> {
		if (!("channel" in this.options.policy) || !canCheckForDesktopUpdate(this.state)) return;
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
		if (!this.options.policy.enabled || this.state.status !== "ready" || this.installing)
			return false;
		this.installing = true;
		this.installError = null;
		try {
			// Use the documented default restart for a notification/menu action:
			// https://www.electron.build/docs/features/auto-update/
			this.updater.quitAndInstall();
			if (this.installError) throw this.installError;
		} catch (error) {
			this.installing = false;
			throw error;
		}
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
