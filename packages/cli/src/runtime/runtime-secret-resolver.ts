import { RUNTIME_AUTH_TOKEN_ENV, readRuntimeAuthToken } from "./auth-token";
import type { RuntimeManifest } from "./manifest-contract";
import { hostedMcpDesiredStateSchema } from "./manifest-resources";
import type { RuntimePaths } from "./paths";
import { type RuntimeEnvironmentAuthority, runtimeSecretValue } from "./secret-values";

const HOSTED_MCP_AUTH_SECRET_REF = `env://${RUNTIME_AUTH_TOKEN_ENV}`;

export interface RuntimeSecretResolver {
	resolve(ref: string): string | null;
	isPrivateFileBacked(ref: string): boolean;
}

export function createRuntimeSecretResolver(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): RuntimeSecretResolver {
	const privateFileBackedRefs = new Set<string>();
	if (paths.mode === "hosted" && hostedMcpAuthSecretRefDeclared(manifest)) {
		privateFileBackedRefs.add(HOSTED_MCP_AUTH_SECRET_REF);
	}

	return {
		resolve(ref) {
			if (privateFileBackedRefs.has(ref)) return readRuntimeAuthToken(paths);
			return runtimeSecretValue(secretValues ?? {}, ref, runtimeEnvironment);
		},
		isPrivateFileBacked(ref) {
			return privateFileBackedRefs.has(ref);
		},
	};
}

function hostedMcpAuthSecretRefDeclared(manifest: RuntimeManifest): boolean {
	const parsed = hostedMcpDesiredStateSchema.safeParse(manifest.projection?.mcp);
	if (!parsed.success) return false;
	for (const server of Object.values(parsed.data.servers)) {
		if (!("url" in server)) continue;
		for (const header of Object.values(server.headers)) {
			if (typeof header !== "string" && header.secretRef === HOSTED_MCP_AUTH_SECRET_REF) {
				return true;
			}
		}
	}
	return false;
}
