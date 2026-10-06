// Each effect setup owns a lease. Replayed setup cannot revive an old action.
export function createActionGate() {
	let active = true;
	let generation = 0;
	let locked = false;
	let owner: unknown;
	return {
		activate(nextOwner?: unknown) {
			if (owner !== nextOwner) {
				owner = nextOwner;
				generation++;
				locked = false;
			}
			active = true;
		},
		deactivate() {
			active = false;
			generation++;
			locked = false;
		},
		acquire() {
			if (!active || locked) return null;
			locked = true;
			const lease = generation;
			const isCurrent = () => active && generation === lease;
			return {
				isCurrent,
				release() {
					if (isCurrent()) locked = false;
				},
			};
		},
	};
}
