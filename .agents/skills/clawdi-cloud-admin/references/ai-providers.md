# Cloud Managed AI Providers

Apply the [shared target/write rules](../SKILL.md#target-and-mutation-rules).
These are managed-provider contracts, not arbitrary user-provider CRUD.
Sources: [admin routes](../../../../backend/app/routes/admin.py),
[request models](../../../../backend/app/schemas/admin.py) and
[managed-provider identity](../../../../backend/app/services/managed_ai_provider.py).

## Supported Surfaces

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/admin/ai-providers/{provider_id}` | Read supported owner-bound runtime metadata |
| PUT | `/v1/admin/ai-providers/{provider_id}` | Upsert/rotate a supported managed provider |
| PUT | `/v1/admin/ai-providers/{provider_id}/runtime-metadata` | Replace non-auth runtime metadata |
| GET | `/v1/admin/ai-providers/{provider_id}/removal-authority` | Read incarnation proof for removal |
| POST | `/v1/admin/ai-providers/{provider_id}/archive` | Archive the exact confirmed incarnation |
| POST | `/v1/admin/ai-providers/{provider_id}/cleanup` | Archive/prove a deployment provider with exact provisioning identity |
| DELETE | `/v1/admin/ai-providers/{provider_id}` | Archive a supported deployment-scoped provider |

Read/delete queries use explicit `kind`/`ref` owner selectors. Use the actual
provider ID and Cloud UUID from owner evidence; do not derive a provider ID
from a public Hosted deployment ID. Fixed `clawdi` upserts use
`target_clerk_id`; deployment-scoped upserts use an `owner` object. Inspect
the route's accepted ID family and request union before choosing a payload.
GET/runtime-metadata supports `clawdi-managed` and valid
`clawdi-v2-deployment-...` identities, not every fixed upsert ID.

```bash
curl -fsS --get \
  -H "X-Admin-Key: $CLAWDI_CLOUD_ADMIN_API_KEY" \
  --data-urlencode "kind=$OWNER_KIND" \
  --data-urlencode "ref=$OWNER_REF" \
  "$CLAWDI_CLOUD_API_URL/v1/admin/ai-providers/$PROVIDER_ID/removal-authority"
```

## Mutation Contracts

Upsert uses `base_url`, private `api_key`, and supported optional
`default_model`, `models`, `label` and `capabilities`. Runtime-metadata
replacement uses `owner`, `base_url` and required `models` (which can be
null); it does not rotate credentials. Verify provider binding and current
runtime evidence separately from a successful metadata write.

Archive requires `Idempotency-Key` and an `AdminAiProviderArchiveRequest`
with `owner` and the exact `expected_incarnation_token` returned by
removal-authority. Replay only the identical authorized request with the
original key. A changed incarnation or reused key with a different request
returns `409`; inspect the new state instead of bypassing the conflict.
`remote_revoke_status=pending` means external revocation remains incomplete.

Cleanup uses `owner`, `expected_provider_uuid` and the recorded
`provisioning_discovery_key`. Its receipt distinguishes active-owner cleanup
from proof of completed principal cleanup. Never fabricate provenance or
use DELETE as a shortcut around those proofs; archived state is not proof
that runtime references or external credentials have been retracted.

For Hosted v2, the owning controller orders reference retraction, provider
mutation and runtime convergence. These admin methods are contract references
for authorized Cloud owners, not instructions to bypass that lifecycle.

Done: provider ownership/identity is proven, any approved mutation has its
fenced receipt, and runtime-reference or remote-revocation gaps remain explicit.
