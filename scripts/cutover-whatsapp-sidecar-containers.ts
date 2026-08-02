const SINGLETON_SERVICE = "clawdi-whatsapp-baileys";
const LEGACY_SERVICE_PREFIX = `${SINGLETON_SERVICE}-`;
const LEGACY_STATE_ROOT = "/home/phala/clawdi-whatsapp-sidecars";

/**
 * Build the one-time, idempotent remote cutover transported through
 * `kamal server exec`. The script validates the complete candidate set before
 * it mutates any container. The retired pilot never held paired credentials,
 * so after every legacy owner is gone it removes only the fixed, validated
 * legacy state root. Docker volumes and the singleton state root are untouched.
 */
export function buildWhatsAppSidecarContainerCutoverCommand(): string {
	const script = `set -eu
singleton_service='${SINGLETON_SERVICE}'
legacy_prefix='${LEGACY_SERVICE_PREFIX}'
legacy_state_root='${LEGACY_STATE_ROOT}'

scan_whatsapp_containers() {
  legacy_ids=''
  seen_legacy_services='|'
  singleton_seen=false
  container_ids="$(docker container ls --all --no-trunc --format '{{.ID}}')"
  for container_id in $container_ids; do
    case "$container_id" in
      *[!0-9a-f]*|'')
        echo 'Invalid full container id returned by Docker during WhatsApp cutover' >&2
        exit 1
        ;;
    esac
    if [ "\${#container_id}" -ne 64 ]; then
      echo 'Invalid full container id returned by Docker during WhatsApp cutover' >&2
      exit 1
    fi

    container_name="$(docker container inspect --format '{{.Name}}' "$container_id")"
    service_label="$(docker container inspect --format '{{index .Config.Labels "service"}}' "$container_id")"
    candidate=false
    case "$container_name" in
      /clawdi-whatsapp-baileys*) candidate=true ;;
    esac
    case "$service_label" in
      clawdi-whatsapp-baileys*) candidate=true ;;
    esac
    if [ "$candidate" != true ]; then
      continue
    fi

    if [ "$container_name" = "/$singleton_service" ] && [ "$service_label" = "$singleton_service" ]; then
      if [ "$singleton_seen" = true ]; then
        echo 'Duplicate Clawdi WhatsApp singleton container' >&2
        exit 1
      fi
      singleton_seen=true
      continue
    fi

    service_name="\${container_name#/}"
    case "$service_name" in
      "$legacy_prefix"*) ;;
      *)
        echo 'Unexpected Clawdi WhatsApp container identity shape' >&2
        exit 1
        ;;
    esac
    if [ "$service_label" != "$service_name" ]; then
      echo 'Mismatched Clawdi WhatsApp container name and service label' >&2
      exit 1
    fi
    suffix="\${service_name#$legacy_prefix}"
    if [ "\${#suffix}" -ne 32 ]; then
      echo 'Malformed legacy Clawdi WhatsApp container identity' >&2
      exit 1
    fi
    case "$suffix" in
      *[!0-9a-f]*)
        echo 'Malformed legacy Clawdi WhatsApp container identity' >&2
        exit 1
        ;;
      ????????????[1-8]???[89ab]???????????????) ;;
      *)
        echo 'Malformed legacy Clawdi WhatsApp container UUID identity' >&2
        exit 1
        ;;
    esac
    case "$seen_legacy_services" in
      *"|$service_name|"*)
        echo 'Duplicate legacy Clawdi WhatsApp container identity' >&2
        exit 1
        ;;
    esac
    seen_legacy_services="\${seen_legacy_services}\${service_name}|"
    legacy_ids="\${legacy_ids} \${container_id}"
  done
}

validate_legacy_state_root() {
  if [ ! -e "$legacy_state_root" ] && [ ! -L "$legacy_state_root" ]; then
    return
  fi
  if [ ! -d "$legacy_state_root" ] || [ -L "$legacy_state_root" ]; then
    echo 'Legacy Clawdi WhatsApp state root is not a real directory' >&2
    exit 1
  fi
  if [ "$(realpath -e "$legacy_state_root")" != "$legacy_state_root" ]; then
    echo 'Legacy Clawdi WhatsApp state root resolved outside its fixed path' >&2
    exit 1
  fi
}

scan_whatsapp_containers
validate_legacy_state_root
for container_id in $legacy_ids; do
  container_name="$(docker container inspect --format '{{.Name}}' "$container_id")"
  service_label="$(docker container inspect --format '{{index .Config.Labels "service"}}' "$container_id")"
  service_name="\${container_name#/}"
  case "$service_name" in
    "$legacy_prefix"*) ;;
    *)
      echo 'Legacy Clawdi WhatsApp container identity changed before stop' >&2
      exit 1
      ;;
  esac
  if [ "$service_label" != "$service_name" ]; then
    echo 'Legacy Clawdi WhatsApp container identity changed before stop' >&2
    exit 1
  fi
  docker container stop --time 30 "$container_id"
  docker container rm "$container_id"
done

scan_whatsapp_containers
if [ -n "$legacy_ids" ]; then
  echo 'Legacy Clawdi WhatsApp containers remain after cutover' >&2
  exit 1
fi

validate_legacy_state_root
if [ -e "$legacy_state_root" ] || [ -L "$legacy_state_root" ]; then
  rm -rf -- "$legacy_state_root"
fi
if [ -e "$legacy_state_root" ] || [ -L "$legacy_state_root" ]; then
  echo 'Legacy Clawdi WhatsApp state root remains after cutover' >&2
  exit 1
fi`;
	const encodedScript = Buffer.from(script, "utf8").toString("base64");
	return `script="$(printf '%s' '${encodedScript}' | base64 -d)" && sh -c "$script"`;
}

if (import.meta.main) {
	process.stdout.write(`${buildWhatsAppSidecarContainerCutoverCommand()}\n`);
}
