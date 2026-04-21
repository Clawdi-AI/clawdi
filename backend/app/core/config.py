from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "extra": "ignore"}

    app_name: str = "clawdi-cloud"
    debug: bool = False
    cors_origins: list[str] = ["http://localhost:3000"]

    database_url: str = "postgresql+asyncpg://clawdi:clawdi_dev@localhost:5433/clawdi_cloud"
    redis_url: str = "redis://localhost:6379/0"

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
