import type { DeploymentUpdateRequest, HostedDeployment } from "@/hosted/billing/contracts";

export const MIN_TCP_PORT = 1;
export const MAX_TCP_PORT = 65_535;

export type PublicPortDraftRow = {
	id: string;
	value: string;
};

export type PublicPortDraftState = {
	rows: PublicPortDraftRow[];
	baselinePorts: number[];
	projectionScope: string;
	projectionIdentity: string;
};

type PublicEndpoint = HostedDeployment["public_endpoints"][number];

export type PublicEndpointAvailability =
	| { kind: "available"; url: string }
	| { kind: "pending" }
	| { kind: "unavailable" };

function canonicalPortOrder(ports: readonly number[]): number[] {
	return [...ports].sort((left, right) => left - right);
}

function publicPortProjectionIdentity(ports: readonly number[]): string {
	return JSON.stringify(canonicalPortOrder(ports));
}

function savedPublicPortRows(ports: readonly number[]): PublicPortDraftRow[] {
	return canonicalPortOrder(ports).map((port) => ({
		id: `saved-${port}`,
		value: String(port),
	}));
}

export function projectPublicHttpPorts(deployment: HostedDeployment): number[] {
	return canonicalPortOrder(
		deployment.resource.spec.ports
			.filter((port) => port.visibility === "public" && port.protocol === "http")
			.map((port) => port.port),
	);
}

export function validatePublicPortDraft(values: readonly string[]): {
	ports: number[] | null;
	errors: Array<string | null>;
} {
	const parsed = values.map((value) => {
		if (!/^[1-9]\d*$/.test(value)) return null;
		const port = Number(value);
		return Number.isSafeInteger(port) && port >= MIN_TCP_PORT && port <= MAX_TCP_PORT ? port : null;
	});
	const counts = new Map<number, number>();
	for (const port of parsed) {
		if (port !== null) counts.set(port, (counts.get(port) ?? 0) + 1);
	}
	const errors = parsed.map((port) => {
		if (port === null) return `Enter a whole number from ${MIN_TCP_PORT} to ${MAX_TCP_PORT}.`;
		if ((counts.get(port) ?? 0) > 1) return "Each public port must be unique.";
		return null;
	});
	return {
		ports:
			errors.some(Boolean) || parsed.some((port) => port === null)
				? null
				: canonicalPortOrder(parsed.filter((port): port is number => port !== null)),
		errors,
	};
}

export function publicPortDraftIsDirty(
	values: readonly string[],
	authoritativePorts: readonly number[],
): boolean {
	const { ports } = validatePublicPortDraft(values);
	const canonicalAuthoritativePorts = canonicalPortOrder(authoritativePorts);
	if (ports === null || ports.length !== canonicalAuthoritativePorts.length) return true;
	return ports.some((port, index) => port !== canonicalAuthoritativePorts[index]);
}

export function createPublicPortDraftState(
	ports: readonly number[],
	projectionScope = "",
): PublicPortDraftState {
	const canonicalPorts = canonicalPortOrder(ports);
	return {
		rows: savedPublicPortRows(canonicalPorts),
		baselinePorts: canonicalPorts,
		projectionScope,
		projectionIdentity: publicPortProjectionIdentity(canonicalPorts),
	};
}

export function reconcilePublicPortDraft(
	state: PublicPortDraftState,
	authoritativePorts: readonly number[],
	projectionScope = "",
): PublicPortDraftState {
	if (state.projectionScope !== projectionScope) {
		return createPublicPortDraftState(authoritativePorts, projectionScope);
	}
	const nextIdentity = publicPortProjectionIdentity(authoritativePorts);
	if (state.projectionIdentity === nextIdentity) return state;

	const values = state.rows.map((row) => row.value);
	const hasLocalEdits = publicPortDraftIsDirty(values, state.baselinePorts);
	const alreadyMatchesNextProjection = !publicPortDraftIsDirty(values, authoritativePorts);
	if (hasLocalEdits && !alreadyMatchesNextProjection) {
		return {
			...state,
			baselinePorts: canonicalPortOrder(authoritativePorts),
			projectionIdentity: nextIdentity,
		};
	}

	return createPublicPortDraftState(authoritativePorts, projectionScope);
}

export function publicPortsUpdate(ports: readonly number[]): DeploymentUpdateRequest {
	return { public_ports: [...ports] };
}

export function publicEndpointsArePending(
	deployment: HostedDeployment,
	mutationPending: boolean,
): boolean {
	const status = deployment.resource.status;
	return (
		mutationPending ||
		status?.summary_state === "updating" ||
		status?.observedGeneration !== deployment.resource.metadata.generation
	);
}

export function publicEndpointAvailability(
	port: number,
	endpoints: readonly PublicEndpoint[],
	pending: boolean,
): PublicEndpointAvailability {
	const endpoint = endpoints.find((candidate) => candidate.port === port);
	if (endpoint) return { kind: "available", url: endpoint.url };
	return pending ? { kind: "pending" } : { kind: "unavailable" };
}
