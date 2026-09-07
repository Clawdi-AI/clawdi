import { isAbsolute } from "node:path";
import { z } from "zod";

export const hostedSkillEvidenceSchema = z
	.object({
		skillKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
		runtime: z.enum(["hermes", "openclaw"]),
		sourceIdentity: z.string().regex(/^[0-9a-f]{64}$/),
		digest: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.nullable(),
		desiredState: z.enum(["present", "absent"]),
		status: z.enum(["installed", "removed", "failed"]),
		targetDir: z.string().refine(isAbsolute).nullable(),
		treeDigest: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.nullable(),
	})
	.strict();
export type HostedSkillEvidence = z.infer<typeof hostedSkillEvidenceSchema>;
