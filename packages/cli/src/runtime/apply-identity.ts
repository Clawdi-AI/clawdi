import { z } from "zod";

export const runtimeApplyIdentitySchema = z
	.object({
		generation: z.number().int().positive(),
		manifestETag: z.string().min(1).max(128),
		applyReceiptId: z.string().min(16).max(128),
		bootNonce: z.string().min(16).max(128),
	})
	.strict();

export type RuntimeApplyIdentity = z.infer<typeof runtimeApplyIdentitySchema>;
