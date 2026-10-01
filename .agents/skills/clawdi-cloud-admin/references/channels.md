# Cloud Channels

Apply the [shared target/write rules](../SKILL.md#target-and-mutation-rules).
Sources: [admin routes](../../../../backend/app/routes/admin.py),
[admin models](../../../../backend/app/schemas/admin.py) and
[channel models](../../../../backend/app/schemas/channel.py).

## Inventory And Management

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/admin/channels` | Filter inventory by provider/visibility and archived state |
| POST | `/v1/admin/channels` | Create a supported bot account |
| GET | `/v1/admin/channels/{account_id}` | Inspect the exact account, including archived state |
| PATCH | `/v1/admin/channels/{account_id}` | Change metadata/status or credentials |
| POST | `/v1/admin/channels/{account_id}/webhook-secret/rotate` | Rotate the stored webhook secret |
| POST | `/v1/admin/channels/{account_id}/commands/sync` | Synchronize provider commands |
| DELETE | `/v1/admin/channels/{account_id}` | Archive the account and propagate affected runtime state |

```bash
curl -fsS --get \
  -H "X-Admin-Key: $CLAWDI_CLOUD_ADMIN_API_KEY" \
  --data-urlencode "provider=$CHANNEL_PROVIDER" \
  --data-urlencode 'include_archived=false' \
  "$CLAWDI_CLOUD_API_URL/v1/admin/channels"
```

The list is not cursor-paginated. Select the exact returned UUID and inspect
its owner, provider, visibility, status and archive state before a write.
Supported providers are `telegram`, `discord` and `whatsapp`.

Creation uses `AdminChannelCreate`: `provider`, `name`, `visibility`,
optional private `provider_token`, `config` and `secrets`. Visibility defaults
to `public`: specify it deliberately. Private channels require
`target_clerk_id`; public inventory rejects a tenant owner. Public WhatsApp
accounts use the physical pairing flow below, not direct channel creation.
Discord needs a bot token and valid interactions config; Telegram/Discord
setup can call providers and commit partial setup before a later failure.
Inspect inventory and provider evidence before retrying creation.

PATCH omission leaves a field unchanged; explicit `provider_token: null` or
`config: null` clears it. Visibility cannot change in place. Token replacement
must preserve Telegram bot/Discord application identity. Creation and webhook
rotation return `webhook_secret`; handle it privately. Rotation's receipt
alone does not prove that external webhook delivery uses the new secret.

Command sync uses `ChannelCommandSyncRequest`: optional `commands` and
`guild_id`. Omitting `commands` invokes configured/default command behavior,
including Discord reconciliation; this is a provider mutation. Account
deletion archives it, can log out WhatsApp, and affects linked runtimes.
Re-read the exact account with archive state and report remaining delivery
or runtime convergence gaps.

## Platform WhatsApp Pairing

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/admin/channels/whatsapp/pairing-sessions` | Start a physical pairing session |
| GET | `/v1/admin/channels/whatsapp/pairing-sessions/{session_id}` | Read session state |
| DELETE | `/v1/admin/channels/whatsapp/pairing-sessions/{session_id}` | Cancel the session |

Use `AdminPlatformWhatsAppPairingSessionCreate`: stable UUID `account_id`,
UUID `request_id` and `name`. Preserve the original request identity after
an uncertain response; inspect the session before another attempt. This
router is `/v1`-only, without an `/api` alias. Pairing artifacts are private.
Use the [sidecar owner runbook](../../../../docs/runbooks/whatsapp-baileys-sidecars.md)
for its registry/lifecycle contract; a session receipt is not message-delivery
proof.

Done: exact inventory ownership is verified, any provider/pairing write has
its read-back, and secrets plus unverified delivery state stay out of shared
success claims.
