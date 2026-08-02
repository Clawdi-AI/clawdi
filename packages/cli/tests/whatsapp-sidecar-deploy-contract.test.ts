import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareWhatsAppSidecarDeploy } from "../../../scripts/prepare-whatsapp-sidecar-deploy";
import {
	buildWhatsAppSidecarContainerPreflightCommand,
	readDesiredWhatsAppSidecarServiceNames,
} from "../../../scripts/whatsapp-sidecar-container-preflight";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_TOKEN = "A".repeat(64);
const SECOND_TOKEN = "B".repeat(64);
const repoRoot = resolve(import.meta.dir, "../../..");
const sidecarDockerfile = readFileSync(
	join(repoRoot, "packages/whatsapp-baileys-sidecar/Dockerfile"),
	"utf8",
);
const deployConfig = readFileSync(join(repoRoot, "config/deploy.yml"), "utf8");
const imageWorkflow = readFileSync(
	join(repoRoot, ".github/workflows/clawdi-image-release.yml"),
	"utf8",
);
const backendWorkflow = readFileSync(join(repoRoot, ".github/workflows/backend-ci.yml"), "utf8");
const materializerSource = readFileSync(
	join(repoRoot, "scripts/prepare-whatsapp-sidecar-deploy.ts"),
	"utf8",
);
const sidecarRunbook = readFileSync(
	join(repoRoot, "docs/runbooks/whatsapp-baileys-sidecars.md"),
	"utf8",
);
const dockerignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");

describe("WhatsApp sidecar deployment materializer", () => {
	test("derives sorted disjoint accounts and keeps tokens out of the manifest", () => {
		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "BASE_SECRET=preserved\n", { mode: 0o600 });
			const rawRegistry = JSON.stringify({
				[SECOND_ID]: entry(SECOND_ID, SECOND_TOKEN),
				[FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN),
			});

			const manifest = prepareWhatsAppSidecarDeploy({ rawRegistry, manifestPath, secretsPath });

			expect(manifest.accounts.map((account) => account.account_id)).toEqual([FIRST_ID, SECOND_ID]);
			expect(new Set(manifest.accounts.map((account) => account.accessory_name)).size).toBe(2);
			expect(new Set(manifest.accounts.map((account) => account.service_name)).size).toBe(2);
			expect(new Set(manifest.accounts.map((account) => account.socket_path)).size).toBe(2);
			expect(readDesiredWhatsAppSidecarServiceNames(manifestPath)).toEqual(
				manifest.accounts.map((account) => account.service_name),
			);
			const publicManifest = readFileSync(manifestPath, "utf8");
			expect(publicManifest).not.toContain(FIRST_TOKEN);
			expect(publicManifest).not.toContain(SECOND_TOKEN);
			expect(publicManifest).toContain(`/run/clawdi-whatsapp/${FIRST_ID}/sidecar.sock`);
			expect(publicManifest).toContain("clawdi-whatsapp-baileys-11111111111141118111111111111111");
			const secrets = readFileSync(secretsPath, "utf8");
			expect(secrets).toContain("BASE_SECRET=preserved");
			expect(secrets).toContain("CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON=");
			expect(secrets).toContain(SECOND_TOKEN);
			expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
			expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
		});
	});

	test("replaces its generated secret block without retaining rotated tokens", () => {
		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "BASE_SECRET=preserved\n", { mode: 0o600 });
			prepareWhatsAppSidecarDeploy({
				rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
				manifestPath,
				secretsPath,
			});
			prepareWhatsAppSidecarDeploy({
				rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, SECOND_TOKEN) }),
				manifestPath,
				secretsPath,
			});

			const secrets = readFileSync(secretsPath, "utf8");
			expect(secrets).not.toContain(FIRST_TOKEN);
			expect(secrets).toContain(SECOND_TOKEN);
			expect(secrets.match(/BEGIN CLAWDI GENERATED/g)).toHaveLength(1);
			expect(secrets.match(/END CLAWDI GENERATED/g)).toHaveLength(1);
		});
	});

	test("fails closed on non-UDS, unstable, or duplicate secret authority", () => {
		expect(materializerSource).not.toContain('process.env[REGISTRY_KEY] ?? "{}"');

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			expect(() =>
				prepareWhatsAppSidecarDeploy({ rawRegistry: "", manifestPath, secretsPath }),
			).toThrow("must be valid JSON");
		});

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "unsafe\n", { mode: 0o600 });
			chmodSync(secretsPath, 0o644);
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
					manifestPath,
					secretsPath,
				}),
			).toThrow("owned mode-600 regular file");
		});

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON=duplicate\n", {
				mode: 0o600,
			});
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
					manifestPath,
					secretsPath,
				}),
			).toThrow("supplied only through the generated sidecar secret block");
		});

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({
						[FIRST_ID]: { api_token: FIRST_TOKEN, base_url: "https://sidecar.test" },
					}),
					manifestPath,
					secretsPath,
				}),
			).toThrow("unknown fields");
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({
						[FIRST_ID]: {
							...entry(FIRST_ID, FIRST_TOKEN),
							unix_socket_path: "/run/clawdi-whatsapp/other/sidecar.sock",
						},
					}),
					manifestPath,
					secretsPath,
				}),
			).toThrow("stable account-scoped socket path");
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({
						[FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN),
						[SECOND_ID]: entry(SECOND_ID, FIRST_TOKEN),
					}),
					manifestPath,
					secretsPath,
				}),
			).toThrow("api_token values must be unique");
		});
	});
});

describe("WhatsApp sidecar remote container preflight", () => {
	test("survives the pinned Kamal 2.12.0 server exec argument normalization", async () => {
		const command = buildWhatsAppSidecarContainerPreflightCommand([serviceName(FIRST_ID)]);
		const normalizedCommand = renderKamalServerExecCommand([`  ${command}\n`]);
		const decodedScript = decodePreflightScript(normalizedCommand);
		const oldMultilineTransport = renderKamalServerExecCommand([decodedScript]);

		expect(command).not.toContain("\n");
		expect(normalizedCommand).toBe(command);
		expect(oldMultilineTransport).toContain("do; case");
		expect(await shellSyntaxExitCode(oldMultilineTransport)).not.toBe(0);
		expect(await shellSyntaxExitCode(normalizedCommand)).toBe(0);
		expect(decodedScript).toContain(
			"docker container ls --all --filter 'label=service' --format '{{.ID}}'",
		);
		expect(decodedScript).toContain(
			'docker container inspect --format \'{{index .Config.Labels "service"}}\' "$container_id"',
		);
		expect(decodedScript).not.toMatch(/\bdocker\s+(?:container\s+)?(?:stop|rm|prune)\b/);
		expect(decodedScript).not.toContain("/state");
		expect((await runRemotePreflight([serviceName(FIRST_ID)], [])).exitCode).toBe(0);
		expect(() =>
			buildWhatsAppSidecarContainerPreflightCommand(["clawdi-whatsapp-baileys-user-input"]),
		).toThrow("invalid WhatsApp sidecar service name");
	});

	test("rejects a desired service name not derived from its account UUID", () => {
		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			const manifest = prepareWhatsAppSidecarDeploy({
				rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
				manifestPath,
				secretsPath,
			});
			const account = manifest.accounts[0];
			if (!account) throw new Error("expected generated sidecar account");
			account.service_name = serviceName(SECOND_ID);
			writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

			expect(() => readDesiredWhatsAppSidecarServiceNames(manifestPath)).toThrow(
				"invalid generated WhatsApp sidecar account identity",
			);
		});
	});

	test("allows zero accounts only when no Clawdi WhatsApp container exists", async () => {
		expect((await runRemotePreflight([], [])).exitCode).toBe(0);

		for (const existing of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
			const result = await runRemotePreflight([], [[existing, serviceName(FIRST_ID)]]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Unexpected Clawdi WhatsApp sidecar container");
		}
	});

	test("allows only one existing container for each exact desired service", async () => {
		const desired = [serviceName(FIRST_ID)];
		expect((await runRemotePreflight(desired, [])).exitCode).toBe(0);
		expect(
			(await runRemotePreflight(desired, [["aaaaaaaaaaaa", serviceName(FIRST_ID)]])).exitCode,
		).toBe(0);

		const unexpected = await runRemotePreflight(desired, [
			["aaaaaaaaaaaa", serviceName(FIRST_ID)],
			["bbbbbbbbbbbb", serviceName(SECOND_ID)],
		]);
		expect(unexpected.exitCode).not.toBe(0);
		expect(unexpected.stderr).toContain(serviceName(SECOND_ID));

		const duplicate = await runRemotePreflight(desired, [
			["aaaaaaaaaaaa", serviceName(FIRST_ID)],
			["bbbbbbbbbbbb", serviceName(FIRST_ID)],
		]);
		expect(duplicate.exitCode).not.toBe(0);
		expect(duplicate.stderr).toContain("Duplicate Clawdi WhatsApp sidecar container");
	});

	test("rejects malformed Clawdi WhatsApp service labels", async () => {
		for (const malformed of [
			"clawdi-whatsapp-baileys-short",
			"clawdi-whatsapp-baileys-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		]) {
			const result = await runRemotePreflight([], [["aaaaaaaaaaaa", malformed]]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Malformed Clawdi WhatsApp sidecar service label");
		}
	});

	test("rejects malformed Docker container ids after Kamal normalization", async () => {
		const result = await runRemotePreflight([], [["not-a-container-id", serviceName(FIRST_ID)]]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Invalid container id returned by Docker");
	});

	test("fails closed without executing when base64 decoding fails or is unavailable", async () => {
		const command = renderKamalServerExecCommand([
			buildWhatsAppSidecarContainerPreflightCommand([]),
		]);
		const directory = mkdtempSync(join(tmpdir(), "clawdi-sidecar-decoder-"));
		const marker = join(directory, "executed");
		try {
			writeFileSync(
				join(directory, "base64"),
				`#!/bin/sh\nprintf '%s\\n' 'touch "${marker}"'\nexit 23\n`,
				{ mode: 0o700 },
			);
			const failedDecode = await Bun.spawn(["/bin/sh", "-c", command], {
				env: { PATH: directory },
				stderr: "ignore",
				stdout: "ignore",
			}).exited;
			expect(failedDecode).toBe(23);
			expect(existsSync(marker)).toBe(false);

			rmSync(join(directory, "base64"));
			const unavailableDecode = await Bun.spawn(["/bin/sh", "-c", command], {
				env: { PATH: directory },
				stderr: "ignore",
				stdout: "ignore",
			}).exited;
			expect(unavailableDecode).not.toBe(0);
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("WhatsApp sidecar production deployment contract", () => {
	test("builds an immutable non-root image from the declared Bun toolchain", () => {
		expect(sidecarDockerfile.match(/FROM oven\/bun:1\.3\.14-alpine/g)).toHaveLength(2);
		expect(sidecarDockerfile).toContain(
			"bun install --frozen-lockfile --production --filter @clawdi/whatsapp-baileys-sidecar",
		);
		expect(sidecarDockerfile).toContain("USER bun:bun");
		expect(sidecarDockerfile).toContain("RUN chmod -R a-w /app");
		expect(sidecarDockerfile).toContain("HEALTHCHECK --interval=10s");
		expect(sidecarDockerfile).toContain("src/healthcheck.ts");
		expect(sidecarDockerfile).not.toContain("EXPOSE");
		expect(dockerignore).toContain("packages/whatsapp-baileys-sidecar/src/*.test.ts");
		expect(backendWorkflow).toContain("Build production sidecar image");
		expect(backendWorkflow).toContain("packages/whatsapp-baileys-sidecar/Dockerfile");
	});

	test("uses one Kamal accessory and two disjoint durable host paths per account", () => {
		expect(deployConfig).toContain("whatsapp_accounts.each do |account|");
		expect(deployConfig).toContain('service: <%= account.fetch("service_name") %>');
		expect(deployConfig).toContain("clawdi-whatsapp-baileys-sidecar:<%= sidecar_image_version %>");
		expect(deployConfig).toContain('/<%= account.fetch("account_id") %>/state');
		expect(deployConfig).toContain('/<%= account.fetch("account_id") %>/run');
		expect(deployConfig).toContain('mode: "700"');
		expect(deployConfig).toContain('mode: "770"');
		expect(deployConfig).not.toContain("owner:");
		expect(deployConfig).not.toContain("group-add:");
		expect(deployConfig).toContain(":ro");
		expect(deployConfig).toContain("read-only: true");
		expect(deployConfig).toContain("cap-drop: ALL");
		expect(deployConfig).toContain("CLAWDI_WA_SIDECAR_SOCKET_PATH");
		expect(deployConfig).not.toContain("CLAWDI_WA_SIDECAR_HOST:");
		expect(deployConfig).toContain("network: bridge");
		expect(deployConfig).not.toContain("network: kamal");
	});

	test("builds exact-SHA sidecars and explicitly performs stop-start reconciliation", () => {
		expect(backendWorkflow).toContain('"packages/whatsapp-baileys-sidecar/**"');
		expect(imageWorkflow).toContain("Build and push WhatsApp sidecar image");
		expect(imageWorkflow).toContain(
			"tags: $" + "{{ env.SIDECAR_IMAGE_NAME }}:$" + "{{ steps.rev.outputs.sha }}",
		);
		expect(imageWorkflow).toContain(
			"CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON: $" +
				"{{ secrets.CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON }}",
		);
		const appDeploy = imageWorkflow.indexOf(
			'kamal deploy -P --version "$' + '{{ needs.build.outputs.image_tag }}"',
		);
		const directoryPrepare = imageWorkflow.indexOf('kamal accessory directories "$accessory"');
		const containerPreflight = imageWorkflow.indexOf(
			"bun run scripts/whatsapp-sidecar-container-preflight.ts",
		);
		const accessoryReboot = imageWorkflow.indexOf('kamal accessory reboot "$accessory"');
		expect(containerPreflight).toBeGreaterThan(0);
		expect(containerPreflight).toBeLessThan(directoryPrepare);
		expect(directoryPrepare).toBeGreaterThan(0);
		expect(directoryPrepare).toBeLessThan(appDeploy);
		expect(imageWorkflow).toContain("realpath -e '$" + "{state_path}'");
		expect(imageWorkflow).toContain("1000:1000:700");
		expect(imageWorkflow).toContain("1000:1000:770");
		expect(appDeploy).toBeGreaterThan(0);
		expect(accessoryReboot).toBeGreaterThan(appDeploy);
		expect(imageWorkflow).toContain(
			"docker container inspect --format '{{.Config.Image}}' '$" + "{service_name}'",
		);
		expect(imageWorkflow).toContain(
			"ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:$" + "{{ needs.build.outputs.image_tag }}",
		);
		expect(imageWorkflow).toContain("src/healthcheck.ts");
		expect(imageWorkflow).not.toContain("kamal accessory remove");
	});

	test("keeps deploy materialization narrow and free of cross-channel or UI behavior", () => {
		for (const forbidden of ["telegram", "discord", "clawdi-hosted"]) {
			expect(materializerSource.toLowerCase()).not.toContain(forbidden);
			expect(sidecarDockerfile.toLowerCase()).not.toContain(forbidden);
		}
		expect(materializerSource).not.toContain("apps/web");
		expect(sidecarDockerfile.match(/COPY apps\/web\/package\.json/g)).toHaveLength(1);
		expect(sidecarDockerfile).not.toContain("COPY --from=dependencies /app/apps/web");
	});

	test("documents fail-closed retirement without automatic state deletion", () => {
		expect(sidecarRunbook).toContain('kamal accessory stop "$WHATSAPP_ACCESSORY"');
		expect(sidecarRunbook).toContain('kamal accessory remove_container "$WHATSAPP_ACCESSORY"');
		expect(sidecarRunbook).toContain("Only now remove this UUID's entry");
		expect(sidecarRunbook).toContain("must not be used here");
		expect(sidecarRunbook).toContain("do not delete or repurpose either");
		expect(imageWorkflow).not.toContain("kamal accessory remove_container");
		expect(imageWorkflow).not.toContain("kamal accessory remove ");
	});
});

function entry(accountId: string, apiToken: string) {
	return {
		api_token: apiToken,
		unix_socket_path: `/run/clawdi-whatsapp/${accountId}/sidecar.sock`,
	};
}

function serviceName(accountId: string): string {
	return `clawdi-whatsapp-baileys-${accountId.replaceAll("-", "")}`;
}

async function runRemotePreflight(
	desiredServices: readonly string[],
	containers: readonly (readonly [id: string, service: string])[],
): Promise<{ exitCode: number; stderr: string }> {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-sidecar-preflight-"));
	chmodSync(directory, 0o700);
	const fakeDocker = join(directory, "docker");
	const listedIds = containers.map(([id]) => `printf '%s\\n' '${id}'`).join("\n    ");
	const inspectedLabels = containers
		.map(([id, service]) => `${id}) printf '%s\\n' '${service}' ;;`)
		.join("\n    ");
	writeFileSync(
		fakeDocker,
		`#!/bin/sh
set -eu
if [ "$1" = container ] && [ "$2" = ls ]; then
  case " $* " in *" --all "*) ;; *) exit 90 ;; esac
  case " $* " in *" --filter label=service "*) ;; *) exit 91 ;; esac
  ${listedIds}
elif [ "$1" = container ] && [ "$2" = inspect ] && [ "$3" = --format ] && [ "$#" -eq 5 ]; then
  case "$5" in
    ${inspectedLabels}
    *) exit 92 ;;
  esac
else
  exit 93
fi
`,
		{ mode: 0o700 },
	);
	chmodSync(fakeDocker, 0o700);
	try {
		const command = renderKamalServerExecCommand([
			buildWhatsAppSidecarContainerPreflightCommand(desiredServices),
		]);
		const processHandle = Bun.spawn(["sh", "-c", command], {
			env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
			stderr: "pipe",
			stdout: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([
			processHandle.exited,
			new Response(processHandle.stderr).text(),
		]);
		return { exitCode, stderr };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// Kamal 2.12.0 joins server exec arguments, then its pinned SSHKit 1.25.0 sanitizes lines.
function renderKamalServerExecCommand(commands: readonly string[]): string {
	return commands
		.map((command) => command.trim())
		.join(" ")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.join("; ");
}

function decodePreflightScript(command: string): string {
	const match = command.match(
		/^script="\$\(printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d\)" && sh -c "\$script"$/,
	);
	if (!match?.[1]) throw new Error("unexpected preflight command transport");
	return Buffer.from(match[1], "base64").toString("utf8");
}

async function shellSyntaxExitCode(command: string): Promise<number> {
	return Bun.spawn(["sh", "-n", "-c", command], {
		stderr: "ignore",
		stdout: "ignore",
	}).exited;
}

function withDeploymentFiles(
	action: (paths: { manifestPath: string; secretsPath: string }) => void,
): void {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-sidecar-deploy-"));
	chmodSync(directory, 0o700);
	try {
		action({
			manifestPath: resolve(directory, "whatsapp-sidecars.json"),
			secretsPath: resolve(directory, "secrets"),
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
