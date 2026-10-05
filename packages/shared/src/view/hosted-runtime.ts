export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];

const RUNTIME_META = {
	openclaw: {
		label: "OpenClaw",
		blurb: "Choose this if you already use OpenClaw and want its Control UI and workflows.",
	},
	hermes: {
		label: "Hermes",
		blurb: "Recommended for most people. Chat with and manage your agent in the Hermes Dashboard.",
	},
} as const satisfies Record<
	HostedRuntime,
	{
		label: string;
		blurb: string;
	}
>;

export function isHostedRuntime(value: string): value is HostedRuntime {
	return (HOSTED_RUNTIMES as readonly string[]).includes(value);
}

export function runtimeDisplayName(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].label;
}

export function runtimeBlurb(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].blurb;
}
