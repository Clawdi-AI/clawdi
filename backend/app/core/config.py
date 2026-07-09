from typing import Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings


def _normalize_pem_env_value(value: str) -> str:
    # Coolify can preserve escaped newlines either as literal "\n" pairs or as
    # a line-continuation backslash followed by a real newline. Build the latter
    # pattern explicitly so Python source line-continuation rules cannot change
    # the string we are matching.
    return value.replace("\\" + "\r\n", "\n").replace("\\" + "\n", "\n").replace("\\n", "\n")


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "extra": "ignore"}

    @field_validator("vault_encryption_key", "encryption_key", mode="before")
    @classmethod
    def _strip_dotenv_comment_placeholders(cls, v: object) -> object:
        # Some .env parsers (including pydantic-settings' dotenv reader) greedily
        # swallow the trailing comment when a value line looks like
        #   VAULT_ENCRYPTION_KEY=  # Generate with: ...
        # producing the literal string "# Generate with: ..." as the value.
        # That passes hex-decoding later with a cryptic error. Normalise it
        # back to the empty string so downstream code treats the key as
        # "not configured" and fails loudly at first use.
        if isinstance(v, str) and v.strip().startswith("#"):
            return ""
        return v

    @field_validator("clerk_secret_key", "clerk_pem_public_key", mode="before")
    @classmethod
    def _strip_wrapping_quotes(cls, v: object) -> object:
        # Coolify's UI sometimes round-trips secret values with literal
        # surrounding quotes (e.g. `'sk_test_...'`). When that env reaches us
        # raw, the quotes end up baked into the Authorization header / JWT
        # public key and Clerk rejects the request with a confusing 401 or
        # signature-verification error. Strip a single matched pair on load
        # so downstream code never has to think about it.
        if isinstance(v, str) and len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        if isinstance(v, str) and "BEGIN PUBLIC KEY" in v:
            return _normalize_pem_env_value(v)
        return v

    @model_validator(mode="after")
    def _normalize_loaded_env_values(self) -> Self:
        if "BEGIN PUBLIC KEY" in self.clerk_pem_public_key:
            self.clerk_pem_public_key = _normalize_pem_env_value(self.clerk_pem_public_key)
        return self

    app_name: str = "clawdi"
    environment: str = "development"  # development | staging | production
    debug: bool = False
    # Kill switch for recall counting (Memory.access_count++ on agent
    # ranked search, run as a background task). Flip to false via env
    # if the extra write per search ever needs to go away without a
    # deploy. See app/services/memory_recall.py.
    memory_recall_counting: bool = True
    cors_origins: list[str] = ["http://localhost:3000"]

    # Externally reachable URL for THIS backend. Used when the backend embeds
    # its own URL into payloads it hands to other processes (MCP client config,
    # invitation links, webhooks). Dev default is localhost; in prod set to
    # e.g. https://api.clawdi.example.
    public_api_url: str = "http://localhost:8000"

    # Externally reachable URL for the WEB DASHBOARD. The CLI device-flow
    # `verification_uri` resolves through this — backend hands the CLI a URL
    # the user opens in a browser. Dev default is the Vite dev server; in
    # prod set to e.g. https://cloud.clawdi.example.
    web_origin: str = "http://localhost:3000"

    # Trust the standard `X-Forwarded-For` / `CF-Connecting-IP`
    # headers as the source of the real client IP. Required for
    # any proxied deployment (Coolify, Cloudflare, k8s ingress)
    # because uvicorn's `request.client.host` is the proxy's
    # address, not the user's. Off by default so a misconfigured
    # local dev / direct-uvicorn setup can't be header-spoofed.
    # Used today by `cli_auth._real_client_ip` to bucket the
    # device-flow rate limiter; without it, ALL CLI logins
    # behind one proxy share a single 90/min bucket and the
    # third concurrent login 429s.
    trust_forwarded_for: bool = False

    database_url: str = "postgresql+asyncpg://clawdi:clawdi_dev@localhost:5433/clawdi"

    # SQLAlchemy connection pool. Default sqlalchemy values
    # (pool_size=5 + max_overflow=10) start to choke at ~10k
    # connected daemons because every SSE refresh tick takes
    # one connection for the duration of the visibility query.
    # Override via env in prod (e.g. DB_POOL_SIZE=20,
    # DB_MAX_OVERFLOW=40 sized to the daemon population).
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_timeout: float = 30.0
    db_pool_recycle: int = 1800  # recycle connections every 30 min

    # Observability (both optional; no-op if not set)
    sentry_dsn: str = ""
    sentry_environment: str = ""  # falls back to `environment` if empty
    sentry_traces_sample_rate: float = 0.0
    slow_request_log_ms: float = 750.0
    metrics_bearer_token: str = ""
    metrics_basic_auth_user: str = "prometheus"
    metrics_basic_auth_password: str = ""

    clerk_pem_public_key: str = ""
    # Optional: Clerk Backend API secret. Used by the snapshot-email-rebind
    # path to fetch a user's verified primary email when the session token
    # doesn't carry an `email` claim. Only consulted when
    # `enable_snapshot_email_rebind` is true.
    clerk_secret_key: str = ""

    # Opt-in for the email-rebind authentication path. When true, an
    # incoming Clerk JWT whose `sub` doesn't match any existing user is
    # rebound onto an existing row by exact email match (using the JWT's
    # email claim, or falling back to a Clerk Backend API lookup if
    # `clerk_secret_key` is set). Designed for preview deployments fed
    # from a production snapshot whose users were issued by a different
    # Clerk instance — sign-in needs to reattach to the snapshot row.
    #
    # Must NEVER be true in production: the rebind treats email as an
    # identity claim, which is only safe when (a) the rebind is gated to
    # snapshot data the operator already trusts, and (b) account takeover
    # is bounded by that snapshot's contents.
    enable_snapshot_email_rebind: bool = False

    # Local browser-dev bypass. When true AND `environment == "development"`,
    # the backend accepts `Authorization: Bearer <dev_auth_token>` as a
    # dashboard user for quick Playwright/manual UI testing without Clerk.
    # Keep this false in every deployed environment.
    dev_auth_bypass: bool = False
    dev_auth_token: str = "dev-bypass"
    dev_auth_clerk_id: str = "dev_browser"
    dev_auth_email: str = "dev@clawdi.local"
    dev_auth_name: str = "Dev User"

    vault_encryption_key: str = ""
    encryption_key: str = ""  # For JWT signing (MCP bridge tokens)

    # Admin endpoints (POST/DELETE /v1/admin/auth/keys) auth.
    # Empty string disables them entirely (returns 503). Set in
    # production to a strong secret (e.g. `openssl rand -hex 32`)
    # to enable batch operations: SaaS migration tooling for live
    # sync, ops-side revocation, etc. Compared with constant-time
    # comparison.
    admin_api_key: str = ""

    composio_api_key: str = ""
    composio_api_base_url: str = "https://backend.composio.dev"

    # File store selection. `local` stores under FILE_STORE_LOCAL_PATH.
    # `s3` uses S3-compatible object storage, including R2, via boto3.
    file_store_type: str = "local"
    file_store_local_path: str = "./data/files"
    file_store_s3_bucket: str = ""
    file_store_s3_region: str = "auto"
    file_store_s3_endpoint_url: str = ""
    file_store_s3_access_key_id: str = ""
    file_store_s3_secret_access_key: str = ""
    file_store_s3_force_path_style: bool = False

    # Memory embedder for the Builtin memory provider.
    # - "local": run paraphrase-multilingual-mpnet-base-v2 via fastembed
    #   (ONNX, ~1GB download on first use, no API key needed). Default.
    # - "api":   call an OpenAI-compatible embeddings endpoint. Set
    #   memory_embedding_api_key, and optionally memory_embedding_base_url
    #   (e.g. https://openrouter.ai/api/v1) and memory_embedding_model.
    memory_embedding_mode: str = "local"
    memory_embedding_api_key: str = ""
    memory_embedding_base_url: str = ""
    memory_embedding_model: str = "text-embedding-3-small"

    # Channel emulation waits. Production defaults preserve the native APIs'
    # long-poll behaviour; tests can lower these without changing route code.
    channel_long_poll_max_seconds: float = 30.0
    channel_long_poll_interval_seconds: float = 0.1
    discord_gateway_poll_interval_seconds: float = 1.0
    channel_message_retention_days: int = 30
    channel_unbound_message_retention_hours: int = 24
    channel_message_cleanup_batch_size: int = 500

    # Shared LLM credentials for any feature that needs chat completions
    # (memory extraction today; session summarization, auto-tagging, etc.
    # tomorrow). OpenAI-compatible endpoint — works with OpenAI itself,
    # OpenRouter, Anthropic-via-proxy, local llama.cpp, etc. Empty
    # `api_key` is the disable signal — features that depend on the LLM
    # return 503 with a clear hint when it's missing. `llm_model` is a
    # process-wide default; individual features can override at the call
    # site if they need a stronger/cheaper model.
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"

    # JSON object keyed by provider/tool id. Each value can include:
    # authorization_url, token_url, client_id, client_secret, scope, audience,
    # and extra_authorize_params. Codex has an official built-in default; this
    # setting can override it or add future verified adapters without routing
    # AI Provider auth through local agent CLIs.
    ai_provider_oauth_config_json: str = ""

    # Managed AI catalog source for the hosted deploy surfaces. When both are
    # set, cloud-api fetches the gateway's OpenAI-compatible `/v1/models`
    # response with the service user key and exposes it as a user-facing
    # read-only catalog. If that fetch fails, `managed_ai_catalog_fallback_json`
    # becomes the single global fallback list for every user.
    managed_ai_catalog_base_url: str = ""
    managed_ai_catalog_api_key: str = ""
    managed_ai_catalog_fallback_json: str = ""

    # Channels provider endpoints. The backend owns channel state directly;
    # these base URLs are only for outbound provider calls.
    channel_telegram_api_base_url: str = "https://api.telegram.org"
    channel_discord_api_base_url: str = "https://discord.com/api/v10"
    channel_discord_gateway_url: str = "wss://gateway.discord.gg"
    channel_whatsapp_graph_api_base_url: str = "https://graph.facebook.com/v20.0"
    channel_whatsapp_baileys_sidecars_json: str = ""


settings = Settings()
