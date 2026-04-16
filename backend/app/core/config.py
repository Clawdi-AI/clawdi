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


settings = Settings()
