import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVICE_NAME_PATTERN = /^clawdi-whatsapp-baileys-[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function buildWhatsAppSidecarContainerPreflightCommand(
	desiredServiceNames: readonly string[],
): string {
	const desired = [...desiredServiceNames].sort();
	for (const serviceName of desired) {
		if (!SERVICE_NAME_PATTERN.test(serviceName)) {
			throw new Error("invalid WhatsApp sidecar service name");
		}
	}
	if (new Set(desired).size !== desired.length) {
		throw new Error("duplicate WhatsApp sidecar service name");
	}

	const desiredCase = desired.length > 0 ? `${desired.join("|")}) ;;` : "";
	return `set -eu
seen_services='|'
container_ids="$(docker container ls --all --filter 'label=service' --format '{{.ID}}')"
for container_id in $container_ids; do
  case "$container_id" in
    ''|*[!0-9a-f]*)
      echo 'Invalid container id returned by Docker during WhatsApp sidecar preflight' >&2
      exit 1
      ;;
  esac
  service_name="$(docker container inspect --format '{{index .Config.Labels "service"}}' "$container_id")"
  case "$service_name" in
    clawdi-whatsapp-baileys-*)
      suffix="\${service_name#clawdi-whatsapp-baileys-}"
      if [ "\${#suffix}" -ne 32 ]; then
        echo 'Malformed Clawdi WhatsApp sidecar service label' >&2
        exit 1
      fi
      case "$suffix" in
        *[!0-9a-f]*)
          echo 'Malformed Clawdi WhatsApp sidecar service label' >&2
          exit 1
          ;;
      esac
      case "$seen_services" in
        *"|\${service_name}|"*)
          echo "Duplicate Clawdi WhatsApp sidecar container: \${service_name}" >&2
          exit 1
          ;;
      esac
      seen_services="\${seen_services}\${service_name}|"
      case "$service_name" in
        ${desiredCase}
        *)
          echo "Unexpected Clawdi WhatsApp sidecar container: \${service_name}" >&2
          exit 1
          ;;
      esac
      ;;
  esac
done`;
}

export function readDesiredWhatsAppSidecarServiceNames(manifestPath: string): string[] {
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		throw new Error("unable to read generated WhatsApp sidecar deployment manifest");
	}
	if (!isRecord(manifest) || manifest.schema_version !== 1 || !Array.isArray(manifest.accounts)) {
		throw new Error("invalid generated WhatsApp sidecar deployment manifest");
	}
	if (Object.keys(manifest).sort().join(",") !== "accounts,schema_version") {
		throw new Error("invalid generated WhatsApp sidecar deployment manifest");
	}
	const serviceNames = manifest.accounts.map((account) => {
		if (
			!isRecord(account) ||
			Object.keys(account).sort().join(",") !==
				"accessory_name,account_id,service_name,socket_path,token_secret_name" ||
			typeof account.account_id !== "string" ||
			!UUID_PATTERN.test(account.account_id)
		) {
			throw new Error("invalid generated WhatsApp sidecar account entry");
		}
		const compactId = account.account_id.replaceAll("-", "");
		if (
			account.accessory_name !== `whatsapp-baileys-${compactId}` ||
			account.service_name !== `clawdi-whatsapp-baileys-${compactId}` ||
			account.socket_path !== `/run/clawdi-whatsapp/${account.account_id}/sidecar.sock` ||
			account.token_secret_name !== `CLAWDI_WA_SIDECAR_TOKEN_${compactId.toUpperCase()}`
		) {
			throw new Error("invalid generated WhatsApp sidecar account identity");
		}
		return account.service_name;
	});
	if (new Set(serviceNames).size !== serviceNames.length) {
		throw new Error("duplicate generated WhatsApp sidecar service name");
	}
	return serviceNames.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
	const manifestPath = resolve(import.meta.dir, "../.kamal/whatsapp-sidecars.json");
	const serviceNames = readDesiredWhatsAppSidecarServiceNames(manifestPath);
	process.stdout.write(`${buildWhatsAppSidecarContainerPreflightCommand(serviceNames)}\n`);
}
