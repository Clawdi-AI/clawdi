import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(runtimeDir, "../../../..");

function repoFile(path: string): string {
	return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("runtime sidecar image contract", () => {
	it("builds a dedicated sidecar envelope without bundling agent runtimes", () => {
		const dockerfile = repoFile("packages/cli/Dockerfile.runtime-sidecar");

		expect(dockerfile).toContain("FROM node:24-bookworm-slim AS runtime");
		expect(dockerfile).toContain("FROM golang:1.26-bookworm AS mitm-builder");
		expect(dockerfile).toContain("supervisor");
		expect(dockerfile).toContain("gosu");
		expect(dockerfile).toContain("util-linux");
		expect(dockerfile).toContain("clawdi-runtime-nsenter");
		expect(dockerfile).toContain("packages/cli/native/mitm-sidecar");
		expect(dockerfile).toContain("CLAWDI_MITM_SIDECAR_BUNDLE");
		expect(dockerfile).toContain("CLAWDI_RUNTIME_DEFAULT_CLI_PACKAGE_SPEC");
		expect(dockerfile).toContain("npm pack --pack-destination");
		expect(dockerfile).toContain("ENTRYPOINT");
		expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--"');
		expect(dockerfile).not.toContain("mitm-broker");
		expect(dockerfile).not.toContain("openclaw.ai/install-cli.sh");
		expect(dockerfile).not.toContain("hermes-agent.nousresearch.com/install.sh");
	});

	it("includes a same-Pod nsenter control adapter without embedding agent CLIs", () => {
		const helper = repoFile("packages/cli/docker/runtime-nsenter-control.sh");

		expect(helper).toContain("Usage:");
		expect(helper).toContain("--state-dir");
		expect(helper).toContain("--marker");
		expect(helper).toContain("nsenter");
		expect(helper).toContain('--root="/proc/$target_pid/root"');
		expect(helper).toContain('--wdns="$workdir"');
		expect(helper).toContain('--setuid="$target_uid"');
		expect(helper).not.toContain("openclaw config");
		expect(helper).not.toContain("hermes");
	});

	it("starts by converging desired state and then hands off to supervisor", () => {
		const entrypoint = repoFile("packages/cli/docker/runtime-sidecar-entrypoint.sh");

		expect(entrypoint).toContain("clawdi runtime init --non-interactive --json");
		expect(entrypoint).toContain(
			'exec supervisord -c "$' + '{CLAWDI_RUN_DIR}/supervisor/supervisord.conf"',
		);
		expect(entrypoint).toContain('schemaVersion: "clawdi.hostPolicy.v1"');
		expect(entrypoint).toContain("CLAWDI_RUNTIME_MANIFEST_URL");
		expect(entrypoint).toContain("CLAWDI_RUNTIME_AUTH_ENV");
	});

	it("publishes the sidecar image independently of backend deploys", () => {
		const workflow = repoFile(".github/workflows/clawdi-image-release.yml");

		expect(workflow).toContain("SIDECAR_IMAGE_NAME: ghcr.io/clawdi-ai/clawdi-runtime-sidecar");
		expect(workflow).toContain("packages/cli/Dockerfile.runtime-sidecar");
		expect(workflow).toContain("sidecar_build_required");
		expect(workflow).toContain(
			"if: needs.build.outputs.backend_build_required == 'true' && needs.build.outputs.should_deploy == 'true'",
		);
	});
});
