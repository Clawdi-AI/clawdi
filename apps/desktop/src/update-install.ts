export interface DesktopUpdateInstallationOptions {
	isReady: () => boolean;
	isBusy: () => boolean;
	stopBackgroundServices: () => Promise<boolean>;
	restoreBackgroundServices: () => Promise<void>;
	install: (onQuit: boolean) => boolean;
}

/** Share shutdown/recovery between the notification, menu and before-quit.
 * Electron before-quit permits preventDefault while services stop asynchronously:
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
		return !this.allowQuit && (this.inProgress || this.options.isReady());
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
			stopped = await this.options.stopBackgroundServices();
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
