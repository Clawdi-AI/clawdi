import { setTimeout } from "node:timers/promises";

export type ModuleState =
	| "unsupported"
	| "preparing"
	| "ready"
	| "draining"
	| "retry_wait"
	| "stopped";

/** An attempt owns all callbacks and workers until they actually settle. */
export class SyncScope {
	readonly controller = new AbortController();
	readonly signal: AbortSignal;
	private readonly tasks = new Set<Promise<unknown>>();
	failure: unknown;
	constructor(parent: AbortSignal) {
		this.signal = AbortSignal.any([parent, this.controller.signal]);
	}
	track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		void task.then(
			() => this.tasks.delete(task),
			() => this.tasks.delete(task),
		);
		return task;
	}
	invoke(callback: () => void | Promise<void>): void {
		if (this.signal.aborted) return;
		try {
			this.track(
				Promise.resolve(callback()).catch((error) => {
					this.failure = error;
					this.controller.abort(error);
				}),
			);
		} catch (error) {
			this.failure = error;
			this.controller.abort(error);
		}
	}
	async join(): Promise<void> {
		this.controller.abort();
		while (this.tasks.size) await Promise.allSettled([...this.tasks]);
	}
	async run(tasks: Promise<void>[]): Promise<void> {
		try {
			await Promise.all(tasks.map((task) => this.track(task)));
		} finally {
			await this.join();
		}
	}
}

export interface ModuleLease<T> {
	binding: T;
	signal: AbortSignal;
	release(): void;
}

export class SyncModule<T extends { run(): Promise<void> }> {
	state: ModuleState;
	private current: { binding: T; scope: SyncScope } | null = null;
	constructor(
		private readonly options: {
			signal: AbortSignal;
			prepare: ((scope: SyncScope) => Promise<T | null>) | null;
			changed(state: ModuleState, error?: unknown): void;
			failed(error: unknown): void;
		},
	) {
		this.state = options.prepare ? "preparing" : "unsupported";
	}
	get available(): boolean {
		return this.state === "ready" && this.current !== null && !this.current.scope.signal.aborted;
	}
	acquire(): ModuleLease<T> | null {
		const current = this.current;
		if (this.state !== "ready" || !current || current.scope.signal.aborted) return null;
		let release = () => {};
		current.scope.track(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		return { binding: current.binding, signal: current.scope.signal, release };
	}
	private publish(state: ModuleState, error?: unknown): void {
		this.state = state;
		this.options.changed(state, error);
	}
	async run(): Promise<void> {
		if (!this.options.prepare) return;
		let delay = 1000;
		while (!this.options.signal.aborted) {
			const scope = new SyncScope(this.options.signal);
			let healthyEndedAt: number | null = null;
			const draining = () => {
				healthyEndedAt ??= Date.now();
				this.publish("draining", scope.signal.reason);
			};
			scope.signal.addEventListener("abort", draining, { once: true });
			let readyAt: number | null = null;
			let failure: unknown;
			let healthyDuration = 0;
			this.publish("preparing");
			try {
				const binding = await this.options.prepare(scope);
				scope.signal.throwIfAborted();
				if (!binding) throw new Error("Sync preparation returned no binding");
				this.current = { binding, scope };
				readyAt = Date.now();
				this.publish("ready");
				await binding.run();
				if (!scope.signal.aborted) throw new Error("Sync worker stopped unexpectedly");
			} catch (error) {
				failure = error;
				if (!this.options.signal.aborted) this.options.failed(error);
			} finally {
				healthyDuration = readyAt === null ? 0 : (healthyEndedAt ?? Date.now()) - readyAt;
				this.publish("draining", failure);
				await scope.join();
				scope.signal.removeEventListener("abort", draining);
				this.current = null;
			}
			if (this.options.signal.aborted) break;
			if (healthyDuration >= 60000) delay = 1000;
			this.publish("retry_wait", failure);
			try {
				await setTimeout(Math.round(delay * (0.8 + Math.random() * 0.4)), undefined, {
					signal: this.options.signal,
				});
			} catch (error) {
				if (!this.options.signal.aborted) throw error;
			}
			delay = Math.min(60000, delay * 2);
		}
		this.publish("stopped");
	}
}
