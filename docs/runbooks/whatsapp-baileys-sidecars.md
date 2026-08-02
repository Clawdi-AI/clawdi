# Managed WhatsApp Baileys Sidecars

Use this runbook for the physical WhatsApp accounts configured through
`CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON`. It does not cover Custom capacity
slots, Agent activation, or any Telegram/Discord provider.

## Topology and invariants

Each map key is one stable `ChannelAccount` UUID, one Kamal accessory, one
Baileys `WASocket`, and one durable host directory:

```text
API + channels-worker (UID/GID 1000, read-only bind)
                    │
                    └── /run/clawdi-whatsapp/<account-uuid>/sidecar.sock
                                      │ HTTP over UDS + unique bearer
                                      ▼
                 clawdi-whatsapp-baileys-sidecar accessory (UID/GID 1000)
                                      │
                                      └── <host-root>/<account-uuid>/state
                                          provider-state.sqlite + WAL
```

The UDS is not published on a host or container TCP port. API and worker get
the same registry secret from Kamal's root `env.secret`; each accessory gets
only its own aliased bearer. API mounts socket directories read-only. The
state directory is mounted only into its account's sidecar. Because UDS does
not need Docker DNS, accessories stay off the app's `kamal` network and use
the explicit Docker `bridge` network only for provider egress.

UDS is deliberately narrower than internal TLS on this single-host topology:
it removes private-CA distribution, leaf issuance/renewal, Docker DNS, and SAN
coordination while retaining the bearer. The existing TCP configuration mode
is unchanged: every non-loopback `base_url` still requires HTTPS. UDS is an
explicit mutually exclusive `unix_socket_path` mode with absolute normalized
path, owner, mode, socket-type, and symlink checks.
[HTTPX documents `uds=` as an explicit HTTP transport option](https://www.python-httpx.org/advanced/transports/#http-transport);
it does not change the origin validator used by TCP configurations.
The tradeoff is deliberate: UDS couples this deployment to one host, stable
paths, and matching numeric identities. A future multi-host topology must use
the existing HTTPS mode with private certificate issuance and rotation rather
than stretching the socket directory across a shared filesystem.

Kamal documents that [accessories are managed separately, are not changed by
`kamal deploy`, and have no zero-downtime deployment](https://kamal-deploy.org/docs/configuration/accessories/).
The release workflow therefore runs `kamal deploy` first, then serially invokes
[`kamal accessory reboot`](https://kamal-deploy.org/docs/commands/accessory/)
and an authenticated readiness probe for every configured account. Reboot is
stop, remove-container, then boot; it never overlaps two physical owners. The
sidecar also acquires SQLite `WAL` + `EXCLUSIVE` locking before it removes a
stale UDS. Repeated releases may cause a short account-by-account provider
transport interruption, but cannot run two sockets.

The image uses the repository's exact `bun@1.3.14` base and `bun.lock`. Bun's
official [`--frozen-lockfile` contract](https://bun.com/docs/pm/cli/install)
fails on manifest/lock drift, and `--production --filter` installs only the
sidecar workspace's runtime graph. The runtime filesystem is read-only except
for a bounded `/tmp` tmpfs, the account state directory, and the account socket
directory. Docker's official references define the image's non-root
[`USER`](https://docs.docker.com/reference/dockerfile/#user), container
[`HEALTHCHECK`](https://docs.docker.com/reference/dockerfile/#healthcheck), and
read-only [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/#use-a-read-only-bind-mount).

## Rollout gates

Do not scan a QR until every gate passes:

1. The host root is on storage encrypted at rest. The SQLite database contains
   WhatsApp auth credentials and Signal keys; directory modes are not a
   substitute for disk/volume encryption. Record the cloud-volume encryption
   control or LUKS/dm-crypt device used for this path.
2. The Kamal SSH user has numeric UID/GID `1000:1000`, matching both production
   images:

   ```bash
   kamal server exec 'test "$(id -u)" = 1000 && test "$(id -g)" = 1000'
   ```

3. `WHATSAPP_BAILEYS_HOST_ROOT` is a persistent absolute host path on local
   block storage. Do not use NFS, SMB, FUSE, an object-store mount, or a shared
   directory. SQLite WAL and exclusive locking require the local filesystem
   contract; SQLite explicitly documents that
   [WAL does not work over a network filesystem](https://sqlite.org/wal.html#overview).
4. The account UUID is generated once and never reassigned. Changing an origin
   or replacing a physical slot requires a new UUID; token rotation does not.
5. The registry contains a different high-entropy bearer for every account.
   Neither the registry nor individual tokens are committed, passed on a
   command line, or printed by the materializer.
6. CI has `CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON` as a GitHub Actions secret
   and `WHATSAPP_BAILEYS_HOST_ROOT` as a repository variable. The secret must
   exist even before the first account is configured; set it explicitly to
   `{}` for zero accounts, because a missing or blank registry fails the
   release. The base `KAMAL_SECRETS` value must not define the registry or
   generated per-account token names; the release materializer owns those
   entries.

Done: `findmnt -T "$WHATSAPP_BAILEYS_HOST_ROOT"` identifies the approved
encrypted local filesystem and the remote UID/GID check exits 0.

## Configure one Shared account

Generate the durable ID and bearer locally. Keep both variables out of shell
tracing and clear them when the secret is uploaded:

```bash
set +x
WHATSAPP_ACCOUNT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
WHATSAPP_SIDECAR_TOKEN="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
WHATSAPP_REGISTRY="$({
  jq -cn \
    --arg id "$WHATSAPP_ACCOUNT_ID" \
    --arg token "$WHATSAPP_SIDECAR_TOKEN" \
    '{($id): {
      unix_socket_path: ("/run/clawdi-whatsapp/" + $id + "/sidecar.sock"),
      api_token: $token
    }}'
})"
printf '%s' "$WHATSAPP_REGISTRY" \
  | gh secret set CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON
unset WHATSAPP_SIDECAR_TOKEN WHATSAPP_REGISTRY
printf 'Record this stable account UUID in the operator inventory: %s\n' "$WHATSAPP_ACCOUNT_ID"
```

Set the non-secret persistent root once:

```bash
gh variable set WHATSAPP_BAILEYS_HOST_ROOT --body '/absolute/encrypted/clawdi-whatsapp-sidecars'
```

Merge and release only after review. The exact-SHA workflow builds both the
backend and `clawdi-whatsapp-baileys-sidecar` images. It materializes a
secret-free account inventory, creates `<host-root>/<uuid>/{state,run}` before
the app bind mounts are evaluated, verifies each host path is canonical and
owned by `1000:1000` with exact `0700`/`0770` modes, deploys API/worker with the
registry, and reboots each accessory serially. It does not call `kamal
accessory remove`, so an app release or sidecar roll-forward cannot delete auth
state.

Done: the release summary names both images at the same full SHA, and the
WhatsApp accessory readiness loop exits 0.

## Fetch and render the QR locally

Install a local terminal QR renderer such as `qrencode`. Call only the
canonical `/v1/admin` route. The response and QR remain in local process memory;
do not enable `curl --verbose`, shell tracing, HTTP recording, or tee/output
files.

```bash
set +x
read -rsp 'Admin API key: ' ADMIN_API_KEY
echo
read -rp 'Target Clerk user id: ' TARGET_CLERK_ID
read -rp 'Stable WhatsApp account UUID: ' WHATSAPP_ACCOUNT_ID
REQUEST_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
ONBOARDING_RESPONSE="$({
  jq -cn \
    --arg account_id "$WHATSAPP_ACCOUNT_ID" \
    --arg target_clerk_id "$TARGET_CLERK_ID" \
    --arg request_id "$REQUEST_ID" \
    --arg name 'Shared' \
    '{$account_id, $target_clerk_id, $request_id, $name}' \
  | curl --fail-with-body --silent --show-error \
      -X POST 'https://cloud-api.clawdi.ai/v1/admin/channels/whatsapp/onboarding' \
      -H "X-Admin-Key: $ADMIN_API_KEY" \
      -H 'Content-Type: application/json' \
      --data-binary @-
})"
ONBOARDING_SESSION_ID="$(jq -er '.id' <<<"$ONBOARDING_RESPONSE")"
jq -er '.qr' <<<"$ONBOARDING_RESPONSE" | qrencode -t ANSIUTF8
unset ONBOARDING_RESPONSE
```

Scan from WhatsApp's linked-device screen. Poll without printing the QR:

```bash
curl --fail-with-body --silent --show-error \
  "https://cloud-api.clawdi.ai/v1/admin/channels/whatsapp/onboarding/$ONBOARDING_SESSION_ID" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  | jq -e '{state, channel_account_id, completed_at}'
unset ADMIN_API_KEY
```

Done: the sanitized response has `state == "connected"` and
`channel_account_id == $WHATSAPP_ACCOUNT_ID`.

## Health and readiness

The image healthcheck calls `/v1/health` over the UDS with that account's
bearer and verifies the returned account UUID. The release gate runs the same
probe from the existing container:

```bash
WHATSAPP_ACCESSORY="whatsapp-baileys-${WHATSAPP_ACCOUNT_ID//-/}"
kamal accessory exec "$WHATSAPP_ACCESSORY" --reuse \
  'bun run /app/packages/whatsapp-baileys-sidecar/src/healthcheck.ts'
kamal accessory logs "$WHATSAPP_ACCESSORY" --lines 100
```

Logs contain generic lifecycle/account IDs but not bearer, QR, phone number,
JID/device metadata, or the session directory. A missing socket, wrong
UID/GID/mode, symlink, account mismatch, unauthenticated response, corrupt
SQLite state, or a second exclusive owner fails closed.

Done: the healthcheck exits 0 and Docker reports the accessory `healthy`.

## Rotate one bearer

Keep the same account UUID, socket path, and state path. Replace only
`api_token` in the GitHub Actions registry secret with a newly generated value,
then dispatch the image release at the exact intended `main` SHA. The app is
deployed with the new registry before the accessory is rebooted with its new
per-account alias, so expect a short transport interruption during that
account's stop/start window. A failed readiness check fails the release.

Do not put the token into `config/deploy.yml`, `KAMAL_SECRETS`, workflow input,
PR text, logs, or an accessory command. The materializer replaces its marked
secret block atomically and its public manifest contains only UUIDs, UDS paths,
accessory names, and secret-key aliases.

Done: the exact-SHA release succeeds, the healthcheck exits 0, and the old
bearer no longer authenticates.

## Backup and restore

Back up one account at a time. Stop the accessory first so shutdown checkpoints
and closes SQLite WAL, then stream `state/` directly into an authenticated
encrypted backup destination. Never back up the `run/` socket directory.

```bash
kamal accessory stop "$WHATSAPP_ACCESSORY"
# On the host, using the approved backup identity and encrypted destination:
tar --numeric-owner -C "$WHATSAPP_BAILEYS_HOST_ROOT/$WHATSAPP_ACCOUNT_ID" -cf - state \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$ENCRYPTED_BACKUP_DESTINATION"
kamal accessory start "$WHATSAPP_ACCESSORY"
kamal accessory exec "$WHATSAPP_ACCESSORY" --reuse \
  'bun run /app/packages/whatsapp-baileys-sidecar/src/healthcheck.ts'
```

For restore, stop the accessory, preserve the current encrypted backup, restore
only into that same UUID's `state/`, then require numeric owner `1000:1000`,
directory mode `0700`, and regular state-file mode `0600` before start. Do not
restore one UUID's database into another UUID; immutable metadata rejects it.
Do not use `kamal accessory remove`: Kamal documents that it removes the
accessory data directory.

On the host, make the current state recoverable and extract the encrypted
archive without touching `run/`:

```bash
RESTORE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ACCOUNT_ROOT="$WHATSAPP_BAILEYS_HOST_ROOT/$WHATSAPP_ACCOUNT_ID"
mv "$ACCOUNT_ROOT/state" "$ACCOUNT_ROOT/state.pre-restore-$RESTORE_STAMP"
install -d -o 1000 -g 1000 -m 0700 "$ACCOUNT_ROOT/state"
age --decrypt "$ENCRYPTED_BACKUP_SOURCE" \
  | tar --extract --numeric-owner -C "$ACCOUNT_ROOT"
chown -R 1000:1000 "$ACCOUNT_ROOT/state"
chmod 0700 "$ACCOUNT_ROOT/state"
find "$ACCOUNT_ROOT/state" -type f -exec chmod 0600 {} +
test "$(stat -c '%u:%g:%a' "$ACCOUNT_ROOT/state")" = '1000:1000:700'
```

Start the accessory and require the authenticated healthcheck shown above.
Delete `state.pre-restore-*` only after the restored account is verified and a
replacement encrypted backup exists.

Done: the restored accessory is healthy and the admin onboarding/status route
reports the same stable account identity.

## Rollback and retirement

Every release publishes the sidecar at the same full SHA as the backend. The
preferred rollback dispatches the image release at a reviewed earlier SHA, with
no newer automatic or manual release pending. That restores the matched backend
and sidecar contract, runs the normal app deploy, then serially stop/starts all
configured accessories at that exact SHA. A sidecar-only rollback is allowed
only when its backend contract and recorded state provenance have been reviewed
as compatible; set `DEPLOY_IMAGE_VERSION` to the old full SHA and run `kamal
accessory reboot "$WHATSAPP_ACCESSORY"`. Both paths preserve the absolute host
state directory. If the old image rejects state provenance, restore a compatible
encrypted backup rather than editing metadata.

Removing an account is a deliberate two-release operation: while it is still
present in the registry, confirm physical logout/archive through the canonical
admin API and stop its accessory; only then remove the registry entry. Retain
the encrypted state backup according to policy. Automatic deployment never
deletes an omitted account's host directory.

Done: the selected image SHA passes authenticated health, and the host state
directory still exists with the same account-bound database.
