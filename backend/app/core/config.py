from pydantic import field_validator
from pydantic_settings import BaseSettings


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

    app_name: str = "clawdi"
    environment: str = "development"  # development | staging | production
    debug: bool = False
    cors_origins: list[str] = ["http://localhost:3000"]

    # Externally reachable URL for THIS backend. Used when the backend embeds
    # its own URL into payloads it hands to other processes (MCP client config,
    # invitation links, webhooks). Dev default is localhost; in prod set to
    # e.g. https://api.clawdi.example.
    public_api_url: str = "http://localhost:8000"

    # Externally reachable URL for the WEB DASHBOARD. The CLI device-flow
    # `verification_uri` resolves through this — backend hands the CLI a URL
    # the user opens in a browser. Dev default is the Next.js dev server; in
    # prod set to e.g. https://cloud.clawdi.example.
    web_origin: str = "http://localhost:3000"

    database_url: str = "postgresql+asyncpg://clawdi:clawdi_dev@localhost:5433/clawdi"

    # Observability (both optional; no-op if not set)
    sentry_dsn: str = ""
    sentry_environment: str = ""  # falls back to `environment` if empty
    sentry_traces_sample_rate: float = 0.0

    clerk_pem_public_key: str = ""

    vault_encryption_key: str = ""
    encryption_key: str = ""  # For JWT signing (MCP proxy tokens)

    composio_api_key: str = ""

    # File store selection. `local` is the only implementation today; S3/R2
    # plug in here without touching routes (see services/file_store.get_file_store).
    file_store_type: str = "local"
    file_store_local_path: str = "./data/files"

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


settings = Settings()
