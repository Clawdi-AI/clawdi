from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "extra": "ignore"}

    app_name: str = "clawdi-cloud"
    environment: str = "development"  # development | staging | production
    debug: bool = False
    cors_origins: list[str] = ["http://localhost:3000"]

    # Externally reachable URL for THIS backend. Used when the backend embeds
    # its own URL into payloads it hands to other processes (MCP client config,
    # invitation links, webhooks). Dev default is localhost; in prod set to
    # e.g. https://api.clawdi.example.
    public_api_url: str = "http://localhost:8000"

    database_url: str = "postgresql+asyncpg://clawdi:clawdi_dev@localhost:5433/clawdi_cloud"

    # Request limits — in-memory sliding window; no Redis.
    disable_rate_limits: bool = False

    # Observability (both optional; no-op if not set)
    sentry_dsn: str = ""
    sentry_environment: str = ""  # falls back to `environment` if empty
    sentry_traces_sample_rate: float = 0.0

    clerk_pem_public_key: str = ""

    vault_encryption_key: str = ""
    encryption_key: str = ""  # For JWT signing (MCP proxy tokens)

    composio_api_key: str = ""

    file_store_type: str = "local"
    file_store_local_path: str = "./data/files"
    file_store_s3_bucket: str = ""
    file_store_s3_region: str = ""

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


settings = Settings()
