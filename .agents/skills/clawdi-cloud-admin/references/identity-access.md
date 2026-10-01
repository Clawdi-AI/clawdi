# Cloud Identity And Access

Apply the [shared target/write rules](../SKILL.md#target-and-mutation-rules).
Contracts: [admin routes](../../../../backend/app/routes/admin.py) and
[request models](../../../../backend/app/schemas/admin.py).

## Agent Identity And Runtime Authority

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/admin/agents` | Register/refresh one explicit Agent identity |
| DELETE | `/v1/admin/agents/{agent_id}` | Archive the Agent and its owned Project through lifecycle checks |
| GET | `/v1/admin/agents/{agent_id}/runtime-state` | Read owner-bound runtime source authority |
| PUT | `/v1/admin/agents/{agent_id}/runtime-state` | Replace the control-plane runtime projection |
| DELETE | `/v1/admin/agents/{agent_id}/runtime-state` | Remove the control-plane runtime projection |

Registration uses `AdminAgentCreate`: `target_clerk_id`, `machine_id`,
`machine_name`, `agent_type`, optional `agent_id`, `default_name`,
`agent_version` and `os_name`. Use the established stable UUID for an
explicit identity; do not invent a replacement during a retry. Registration
can create a Cloud user and updates identity metadata; it is a write.

There is no `GET /v1/admin/agents` inventory endpoint. Runtime authority reads
require `PlatformOwner` query fields `kind` and `ref`:

```bash
curl -fsS --get \
  -H "X-Admin-Key: $CLAWDI_CLOUD_ADMIN_API_KEY" \
  --data-urlencode "kind=$OWNER_KIND" \
  --data-urlencode "ref=$OWNER_REF" \
  "$CLAWDI_CLOUD_API_URL/v1/admin/agents/$AGENT_ID/runtime-state"
```

`kind` is `clerk` or `partner_tenant`; `ref` is that principal's stable
identifier. The response exposes source revision/ETag and identity, not the
full rendered manifest or proof of runtime readiness.

Deletion accepts optional `target_clerk_id`; include the confirmed Clerk
owner when applicable. It has Agent/Project lifecycle consequences and does
not delete the Cloud account. Runtime projection writes use
`AdminRuntimeStateUpsert`, including separate content `generation` and
deployment `apply_generation`, plus validated runtime and secret schemas.
These routes document control-plane contracts, not a manual Hosted repair:
Hosted v2 lifecycle, projection and retraction remain controller-owned.

## API Keys And Principal Suspension

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/admin/auth/keys` | Mint an API key for a Clerk account |
| DELETE | `/v1/admin/auth/keys/{key_id}` | Revoke that exact key |
| PUT | `/v1/admin/auth/suspensions` | Set/clear the platform-owned Clerk authentication fence |

Key minting uses `AdminApiKeyCreate`: `target_clerk_id`, `label`, optional
`environment_id`, `scopes` and `managed`. Omitted/null `scopes` means full
account API permissions. Establish the approved permissions and binding
before minting; the route verifies that a bound Agent belongs to the owner.
`environment_id` is a legacy wire name for the stable Agent UUID.

`raw_key` is returned once. Deliver it only through the approved private
credential mechanism. Minting has no idempotency-key contract; a timeout
must not trigger another mint. There is no admin key-list/detail route: use
approved audit or separately authorized owner evidence, and stop if the
outcome cannot be established. Revoke returns `status=revoked` for an already
revoked key; a `404` means the key ID is absent, after verifying the target.

Suspension JSON uses `target_clerk_id`, `suspended` and a canonical non-empty
`reason`. It can fence a Clerk principal before first login while retaining
resources/credentials. Clearing it neither clears Clerk's own ban nor
recreates a deleted principal. Its receipt includes `changed` and the current
suspension state; there is no separate admin suspension GET endpoint.

## Global Settings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/admin/settings` | List registered global settings |
| GET | `/v1/admin/settings/{key}` | Read one setting |
| PUT | `/v1/admin/settings/{key}` | Atomically replace its whole JSON value |

`AdminAppSettingUpsert` accepts only `value`. This is Cloud global
configuration: it has no Hosted-style per-user overrides, `value_type` or
setting deletion API. Read the registered key's schema before replacement;
omitted nested fields are not a partial patch. Re-read the same key afterward.
See [local setting example](../../../../docs/backend-development.md#local-admin-api).

Done: the exact principal/Agent/key/setting is established, requested effects
are authorized, and receipt plus supported read-back agree or the evidence
gap is reported.
