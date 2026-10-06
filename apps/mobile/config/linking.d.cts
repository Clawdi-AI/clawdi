export function readLinkHosts(value: unknown): string[];

export const webLinkPaths: readonly (
	| { path: string; pathPrefix?: never }
	| { pathPrefix: string; path?: never }
)[];
