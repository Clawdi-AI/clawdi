# Cloud Platform Bootstrap

Apply the [shared target/write rules](../SKILL.md#target-and-mutation-rules).
Sources: [admin routes/models](../../../../backend/app/routes/admin.py),
[bootstrap service](../../../../backend/app/services/provider_environment_verifier_access.py),
[signer models](../../../../backend/app/schemas/admin.py) and
[verifier models](../../../../backend/app/schemas/provider_environment_repair.py).

## Admin Surfaces

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/admin/platform/workload-clients` | Register one public client assertion key |
| GET | `/v1/admin/platform/workload-clients/{client_id}/provider-environment-verifier` | Inspect verifier permission and revision |
| PUT | `/v1/admin/platform/workload-clients/{client_id}/provider-environment-verifier` | Grant/revoke verifier permission against that revision |
| POST | `/v1/admin/platform/signing-keys` | Register a public Cloud signing key with a configured signer |

All three writes require `Idempotency-Key`. Keep the same key and payload
for an identical authorized retry; reused keys with different requests return
`409`. Bootstrap is create-once: it cannot replace keys or resurrect clients.

Client JSON uses `client_id`, `assertion_kid`, `assertion_algorithm`,
`public_jwk` and `reason`. It initially grants only
`platform:runtime-state:write`, not environment-verifier permission.
Read the resulting client before requesting any additional authority:

```bash
curl -fsS \
  -H "X-Admin-Key: $CLAWDI_CLOUD_ADMIN_API_KEY" \
  "$CLAWDI_CLOUD_API_URL/v1/admin/platform/workload-clients/$CLIENT_ID/provider-environment-verifier"
```

Verifier JSON uses `expected_revision` from that read, `action=grant|revoke`
and `reason`. A stale revision returns `412`; inspect it and re-establish
authorization rather than silently changing the approved proof. Verify the
returned `granted`, status, fingerprint and revision with the same GET.

Signer JSON uses `kid`, `algorithm`, `public_jwk`, timezone-aware
`not_before`/`expires_at` and `reason`. The service verifies the configured
private signer matches the public key; posting a public JWK does not install
private signing material. No admin signer-list/detail route is available:
preserve its receipt and report any remaining signer evidence gap.

Keys must be public-only JWKs for `RS256` (RSA at least 2048 bits) or `ES256`
(P-256), with matching `kid`/`alg`. Client assertion and Cloud signing keys
must be separate. Do not add private JWK fields or persist secrets through
these admin requests.

## Workload Boundary

`/v1/platform/*` is a separate workload surface. Its OAuth token endpoint uses
client assertions and rejects `X-Admin-Key`; admin bootstrap does not make
that header valid for workload operations. Read the
[workload router](../../../../backend/app/routes/platform.py) and
[authentication owner](../../../../backend/app/services/platform_workload_auth.py)
for its scope, ownership and fencing contracts. Use the existing controller
for Hosted-owned lifecycle work rather than issuing ad-hoc workload tokens.

Done: bootstrap or permission receipts match the authorized public key/scope,
supported read-back agrees, and any signer or controller evidence gap is
reported.
