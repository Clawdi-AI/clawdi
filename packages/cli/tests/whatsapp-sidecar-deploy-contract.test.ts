import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildWhatsAppSidecarContainerCutoverCommand } from "../../../scripts/cutover-whatsapp-sidecar-containers";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_CONTAINER_ID = "a".repeat(64);
const SECOND_CONTAINER_ID = "b".repeat(64);
const SINGLETON = "clawdi-whatsapp-baileys";
const repoRoot = resolve(import.meta.dir, "../../..");
const deploy = readFileSync(resolve(repoRoot, "config/deploy.yml"), "utf8");
const workflow = readFileSync(
	resolve(repoRoot, ".github/workflows/clawdi-image-release.yml"),
	"utf8",
);
const backendWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/backend-ci.yml"), "utf8");
const cutoverSource = readFileSync(
	resolve(repoRoot, "scripts/cutover-whatsapp-sidecar-containers.ts"),
	"utf8",
);
const runbook = readFileSync(
	resolve(repoRoot, "docs/runbooks/whatsapp-baileys-sidecars.md"),
	"utf8",
);
const dockerfile = readFileSync(
	resolve(repoRoot, "packages/whatsapp-baileys-sidecar/Dockerfile"),
	"utf8",
);

type FakeContainer = {
	id: string;
	name: string;
	serviceLabel: string;
};

describe("WhatsApp sidecar legacy-container cutover", () => {
	test("renders intact through pinned Kamal 2.12 server-exec normalization", async () => {
		const command = buildWhatsAppSidecarContainerCutoverCommand();
		const normalized = renderKamalServerExecCommand([`  ${command}\n`]);
		const decoded = decodeCutoverScript(normalized);

		expect(command).not.toContain("\n");
		expect(normalized).toBe(command);
		expect(await shellSyntaxExitCode(normalized)).toBe(0);
		expect(decoded).toContain("docker container ls --all --no-trunc --format '{{.ID}}'");
		expect(decoded).toContain(
			`docker container inspect --format '{{index .Config.Labels "service"}}'`,
		);
		expect(decoded.indexOf("scan_whatsapp_containers")).toBeLessThan(
			decoded.indexOf('docker container stop --time 30 "$container_id"'),
		);
		expect(decoded).toContain('docker container rm "$container_id"');
		expect(decoded).not.toMatch(/docker\s+(?:container\s+)?(?:prune|rm\s+-v)\b/);
		expect(decoded).toContain("legacy_state_root='/home/phala/clawdi-whatsapp-sidecars'");
		expect(decoded).toContain('rm -rf -- "$legacy_state_root"');
		expect(decoded).not.toMatch(/\b(?:cp|mv|rsync)\b/);
		expect(decoded).not.toContain("/home/phala/clawdi-whatsapp/state");
	});

	test("gracefully retires one exact legacy account container and preserves singleton", async () => {
		const legacy = legacyContainer(FIRST_CONTAINER_ID, FIRST_ID);
		const singleton = singletonContainer(SECOND_CONTAINER_ID);
		const result = await runRemoteCutover([legacy, singleton], "directory");

		expect(result.exitCode).toBe(0);
		expect(result.operations).toEqual([`stop:${FIRST_CONTAINER_ID}`, `rm:${FIRST_CONTAINER_ID}`]);
		expect(result.remainingIds).toEqual([SECOND_CONTAINER_ID]);
		expect(result.legacyStateRootExists).toBe(false);
	});

	test("rejects a symlinked legacy root before mutating a validated container", async () => {
		const result = await runRemoteCutover(
			[legacyContainer(FIRST_CONTAINER_ID, FIRST_ID)],
			"symlink",
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("state root is not a real directory");
		expect(result.operations).toEqual([]);
		expect(result.remainingIds).toEqual([FIRST_CONTAINER_ID]);
		expect(result.legacyStateRootExists).toBe(true);
	});

	test("accepts zero legacy containers and repeat releases without treating singleton as legacy", async () => {
		const singleton = singletonContainer(FIRST_CONTAINER_ID);
		const first = await runRemoteCutover([singleton]);
		expect(first).toMatchObject({ exitCode: 0, operations: [] });
		expect(first.remainingIds).toEqual([FIRST_CONTAINER_ID]);

		const second = await runRemoteCutover([singleton]);
		expect(second).toMatchObject({ exitCode: 0, operations: [] });
		expect(second.remainingIds).toEqual([FIRST_CONTAINER_ID]);
	});

	test("fails before mutation on malformed, mismatched, duplicate, or unexpected identities", async () => {
		const firstService = legacyService(FIRST_ID);
		const malformed = await runRemoteCutover([
			{
				id: FIRST_CONTAINER_ID,
				name: "/clawdi-whatsapp-baileys-short",
				serviceLabel: "clawdi-whatsapp-baileys-short",
			},
		]);
		expect(malformed.exitCode).not.toBe(0);
		expect(malformed.stderr).toContain("Malformed legacy");
		expect(malformed.operations).toEqual([]);

		const mismatch = await runRemoteCutover([
			{
				id: FIRST_CONTAINER_ID,
				name: `/${firstService}`,
				serviceLabel: legacyService(SECOND_ID),
			},
		]);
		expect(mismatch.exitCode).not.toBe(0);
		expect(mismatch.stderr).toContain("Mismatched");
		expect(mismatch.operations).toEqual([]);

		const duplicate = await runRemoteCutover([
			legacyContainer(FIRST_CONTAINER_ID, FIRST_ID),
			legacyContainer(SECOND_CONTAINER_ID, FIRST_ID),
		]);
		expect(duplicate.exitCode).not.toBe(0);
		expect(duplicate.stderr).toContain("Duplicate legacy");
		expect(duplicate.operations).toEqual([]);

		const unexpected = await runRemoteCutover([
			{
				id: FIRST_CONTAINER_ID,
				name: "/clawdi-whatsapp-baileys-helper",
				serviceLabel: "other-service",
			},
		]);
		expect(unexpected.exitCode).not.toBe(0);
		expect(unexpected.stderr).toContain("Mismatched");
		expect(unexpected.operations).toEqual([]);
	});

	test("fails closed when the Docker listing is not a full immutable id", async () => {
		const result = await runRemoteCutover([legacyContainer("a".repeat(12), FIRST_ID)]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Invalid full container id");
		expect(result.operations).toEqual([]);
	});
});

describe("WhatsApp sidecar production deployment contract", () => {
	test("uses one fixed business-neutral accessory and a clean session state root", () => {
		expect(deploy.match(/^ {2}whatsapp-baileys:$/gm)).toHaveLength(1);
		expect(deploy).toContain("service: clawdi-whatsapp-baileys");
		expect(deploy).toContain("network: bridge");
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/state");
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/run");
		expect(deploy).toContain("CLAWDI_WA_SIDECAR_STATE_ROOT: /data");
		expect(deploy).toContain("CLAWDI_WA_SIDECAR_SOCKET_PATH: /run/clawdi-whatsapp/sidecar.sock");
		expect(deploy).toContain("CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN");
		expect(deploy).not.toContain("whatsapp_accounts");
	});

	test("cuts over and health-checks singleton before deploying the new backend", () => {
		const cutover = workflow.indexOf("cutover-whatsapp-sidecar-containers.ts");
		const reboot = workflow.indexOf("kamal accessory reboot whatsapp-baileys");
		const health = workflow.indexOf("src/healthcheck.ts", reboot);
		const appDeploy = workflow.indexOf(
			`kamal deploy -P --version "\${{ needs.build.outputs.image_tag }}"`,
		);

		expect(cutover).toBeGreaterThan(0);
		expect(reboot).toBeGreaterThan(cutover);
		expect(health).toBeGreaterThan(reboot);
		expect(appDeploy).toBeGreaterThan(health);
		expect(workflow).toContain("Build and push WhatsApp sidecar image");
		expect(workflow).toContain(
			`ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:\${{ needs.build.outputs.image_tag }}`,
		);
		expect(workflow).toContain("kamal accessory directories whatsapp-baileys");
		expect(workflow).toContain("docker container inspect --format '{{.Config.Image}}'");
	});

	test("contains no state migration path and retires only the fixed pilot root", () => {
		const runtimeSources = [deploy, workflow, backendWorkflow, cutoverSource].join("\n");
		expect(runtimeSources).not.toMatch(/\b(?:cp|mv|rsync)\b/);
		expect(runbook).toMatch(/intentionally no\s+state copy or migration/);
		expect(cutoverSource).toContain(
			'const LEGACY_STATE_ROOT = "/home/phala/clawdi-whatsapp-sidecars"',
		);
		expect(cutoverSource).toContain('rm -rf -- "$legacy_state_root"');
		expect(cutoverSource).not.toContain("/home/phala/clawdi-whatsapp/state");
	});

	test("keeps state private and exposes only a read-only Unix socket to the app", () => {
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/run:/run/clawdi-whatsapp:ro");
		expect(deploy).toContain('remote: /data\n        mode: "700"');
		expect(deploy).toContain('remote: /run/clawdi-whatsapp\n        mode: "770"');
		expect(deploy).toContain("read-only: true");
		expect(deploy).toContain(
			"memory: 2g # bounded headroom for multiple isolated provider sessions",
		);
		expect(deploy).toContain("ulimit: nofile=65536:65536");
		expect(deploy).toContain("cap-drop: ALL");
		expect(deploy).toContain("security-opt: no-new-privileges:true");
	});

	test("builds a non-root bounded image from the repository Bun toolchain", () => {
		expect(dockerfile).toContain("FROM oven/bun:1.3.14-alpine");
		expect(dockerfile).toContain("bun install --frozen-lockfile --production");
		expect(dockerfile).toContain("USER bun:bun");
		expect(dockerfile).toContain("HEALTHCHECK");
		expect(dockerfile).not.toContain("latest");
	});
});

function legacyService(accountId: string): string {
	return `${SINGLETON}-${accountId.replaceAll("-", "")}`;
}

function legacyContainer(id: string, accountId: string): FakeContainer {
	const service = legacyService(accountId);
	return { id, name: `/${service}`, serviceLabel: service };
}

function singletonContainer(id: string): FakeContainer {
	return { id, name: `/${SINGLETON}`, serviceLabel: SINGLETON };
}

async function runRemoteCutover(
	containers: readonly FakeContainer[],
	legacyState: "absent" | "directory" | "symlink" = "absent",
): Promise<{
	exitCode: number;
	operations: string[];
	remainingIds: string[];
	legacyStateRootExists: boolean;
	stderr: string;
}> {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-sidecar-cutover-"));
	const stateDirectory = join(directory, "containers");
	const legacyStateRoot = join(directory, "legacy-state-root");
	const operationsPath = join(directory, "operations");
	const fakeDocker = join(directory, "docker");
	writeFileSync(operationsPath, "");
	mkdirSync(stateDirectory);
	if (legacyState === "directory") {
		mkdirSync(legacyStateRoot);
		writeFileSync(join(legacyStateRoot, "unused-pilot-state"), "unused\n");
	} else if (legacyState === "symlink") {
		const symlinkTarget = join(directory, "symlink-target");
		mkdirSync(symlinkTarget);
		symlinkSync(symlinkTarget, legacyStateRoot);
	}
	for (const container of containers) {
		writeFileSync(
			join(stateDirectory, container.id),
			`${container.name}|${container.serviceLabel}\n`,
		);
	}
	writeFileSync(
		fakeDocker,
		`#!/bin/sh
set -eu
state_directory='${stateDirectory}'
operations_path='${operationsPath}'
if [ "$1" != container ]; then
  exit 90
fi
case "$2" in
  ls)
    [ "$#" -eq 6 ]
    [ "$3" = --all ]
    [ "$4" = --no-trunc ]
    [ "$5" = --format ]
    [ "$6" = '{{.ID}}' ]
    for path in "$state_directory"/*; do
      [ -f "$path" ] || continue
      printf '%s\\n' "\${path##*/}"
    done
    ;;
  inspect)
    [ "$#" -eq 5 ]
    [ "$3" = --format ]
    identity="$(sed -n '1p' "$state_directory/$5")"
    case "$4" in
      '{{.Name}}') printf '%s\\n' "\${identity%%|*}" ;;
      '{{index .Config.Labels "service"}}') printf '%s\\n' "\${identity#*|}" ;;
      *) exit 91 ;;
    esac
    ;;
  stop)
    [ "$#" -eq 5 ]
    [ "$3" = --time ]
    [ "$4" = 30 ]
    [ -f "$state_directory/$5" ]
    printf 'stop:%s\\n' "$5" >> "$operations_path"
    ;;
  rm)
    [ "$#" -eq 3 ]
    [ -f "$state_directory/$3" ]
    printf 'rm:%s\\n' "$3" >> "$operations_path"
    rm -f "$state_directory/$3"
    ;;
  *) exit 92 ;;
esac
`,
		{ mode: 0o700 },
	);
	chmodSync(fakeDocker, 0o700);

	try {
		const cutoverCommand = commandWithLegacyStateRoot(legacyStateRoot);
		const processHandle = Bun.spawn(["sh", "-c", renderKamalServerExecCommand([cutoverCommand])], {
			env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
			stderr: "pipe",
			stdout: "ignore",
		});
		const [exitCode, stderr] = await Promise.all([
			processHandle.exited,
			new Response(processHandle.stderr).text(),
		]);
		const operations = readFileSync(operationsPath, "utf8").trim().split("\n").filter(Boolean);
		const remainingIds = readdirSync(stateDirectory).sort();
		return {
			exitCode,
			operations,
			remainingIds,
			legacyStateRootExists: existsSync(legacyStateRoot),
			stderr,
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function commandWithLegacyStateRoot(legacyStateRoot: string): string {
	if (legacyStateRoot.includes("'")) throw new Error("unsafe test path");
	const decoded = decodeCutoverScript(buildWhatsAppSidecarContainerCutoverCommand());
	const replaced = decoded.replace(
		"legacy_state_root='/home/phala/clawdi-whatsapp-sidecars'",
		`legacy_state_root='${legacyStateRoot}'`,
	);
	if (replaced === decoded) throw new Error("legacy state root seam not found");
	const encoded = Buffer.from(replaced, "utf8").toString("base64");
	return `script="$(printf '%s' '${encoded}' | base64 -d)" && sh -c "$script"`;
}

// Kamal 2.12.0 joins server-exec arguments, then pinned SSHKit 1.25.0 sanitizes lines.
function renderKamalServerExecCommand(commands: readonly string[]): string {
	return commands
		.map((command) => command.trim())
		.join(" ")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.join("; ");
}

function decodeCutoverScript(command: string): string {
	const match = command.match(
		/^script="\$\(printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d\)" && sh -c "\$script"$/,
	);
	if (!match?.[1]) throw new Error("unexpected cutover command transport");
	return Buffer.from(match[1], "base64").toString("utf8");
}

async function shellSyntaxExitCode(command: string): Promise<number> {
	return Bun.spawn(["sh", "-n", "-c", command], {
		stderr: "ignore",
		stdout: "ignore",
	}).exited;
}
