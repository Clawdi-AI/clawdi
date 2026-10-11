export class DesktopMutationBlockedError extends Error {}

/** Admit work synchronously; exclusive cleanup/update drains work already accepted. */
export class DesktopMutations {
	private active = 0;
	private reason: string | null = null;
	private readonly waiters = new Set<() => void>();

	constructor(private readonly onChange: () => void = () => {}) {}

	get activeCount(): number {
		return this.active;
	}

	get blocked(): boolean {
		return this.reason !== null;
	}

	async run<T>(action: () => Promise<T>): Promise<T> {
		if (this.reason) throw new DesktopMutationBlockedError(this.reason);
		this.active += 1;
		this.onChange();
		try {
			return await action();
		} finally {
			this.active -= 1;
			if (this.active === 0) {
				for (const resolve of this.waiters) resolve();
				this.waiters.clear();
			}
			this.onChange();
		}
	}

	block(reason: string): { drained: Promise<void>; release: () => void } {
		if (this.reason) throw new DesktopMutationBlockedError(this.reason);
		this.reason = reason;
		this.onChange();
		let released = false;
		return {
			drained:
				this.active === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.add(resolve)),
			release: () => {
				if (released) return;
				released = true;
				this.reason = null;
				this.onChange();
			},
		};
	}
}
