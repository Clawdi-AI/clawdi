export function readLinkHosts(value: unknown): string[];

export const webLinkPaths: readonly (
	| { path: string; pathPrefix?: never }
	| { pathPrefix: string; path?: never }
)[];

export const agentFilePaths: Readonly<{
	getStarted: string;
	legacyGuide: string;
	skill: string;
	discoveryIndex: string;
	llms: string;
}>;
export const webLinkExclusions: readonly string[];
export function isBrowserLinkPath(path: string): boolean;
