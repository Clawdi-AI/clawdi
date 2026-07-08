export const HOSTED_MITM_ENGINE = "mitmproxy";

export interface HostedMitmEngineControlPaths {
	envFile: string;
	profileBundlePath: string;
	secretFilePath: string | null;
	addonPath: string;
	binaryPath: string;
}

export interface HostedMitmEngineControl {
	engine: typeof HOSTED_MITM_ENGINE;
	paths: HostedMitmEngineControlPaths;
	transparentPort: number;
}
