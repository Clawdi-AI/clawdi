import { z } from "zod";

export const egressEngineSchema = z.object({
	type: z.literal("mitmproxy"),
	version: z.string().min(1),
	url: z.string().url(),
	sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

export type EgressEnginePin = z.infer<typeof egressEngineSchema>;
