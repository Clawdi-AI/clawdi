import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of the input. Used by `clawdi push` to fingerprint
 * each session's serialized messages so the backend can decide whether
 * to skip content reupload, and by `clawdi pull` to diff cloud state
 * against local sidecar files.
 */
export function sha256Hex(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}
