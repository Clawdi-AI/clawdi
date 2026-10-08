export interface DesktopUpdateInstallationOptions {
	platform: NodeJS.Platform;
	isReady: () => boolean;
	isBusy: () => boolean;
	stopBackgroundServices: () => Promise<boolean>;
	restoreBackgroundServices: () => Promise<void>;
	install: (onQuit: boolean) => boolean;
}

/** Keep macOS/Linux daemons running during replacement; only Windows needs
 * shutdown/recovery for executable locks. Electron before-quit permits deferral:
 * https://www.electronjs.org/docs/latest/api/app#event-before-quit */
export class DesktopUpdateInstallation {
	private inProgress = false;
	private allowQuit = false;
	private quitPending = false;

	constructor(private readonly options: DesktopUpdateInstallationOptions) {}

	get isInProgress(): boolean {
		return this.inProgress;
	}

	shouldDeferQuit(): boolean {
		// macOS/Linux normally use the updater's quit listener directly. Calling
		// app.quit() again from before-quit would reenter Electron's quit sequence.
		return (
			!this.allowQuit &&
			(this.inProgress ||
				(this.options.isReady() && (this.options.platform === "win32" || this.options.isBusy())))
		);
	}

	async resumePendingQuit(): Promise<void> {
		if (this.quitPending) await this.install(true);
	}

	async install(onQuit: boolean): Promise<void> {
		if (this.inProgress || !this.options.isReady()) return;
		if (this.options.isBusy()) {
			if (onQuit) this.quitPending = true;
			return;
		}
		this.quitPending = false;
		this.inProgress = true;
		let stopped = false;
		try {
			if (this.options.platform === "win32") stopped = await this.options.stopBackgroundServices();
			// Allow the updater's own quit, rather than intercepting it again.
			this.allowQuit = true;
			if (!this.options.install(onQuit))
				throw new Error("The downloaded update is no longer ready.");
		} catch (error) {
			this.allowQuit = false;
			try {
				if (stopped) await this.options.restoreBackgroundServices();
			} finally {
				this.inProgress = false;
			}
			throw error;
		}
	}
}
