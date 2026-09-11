"""Export the owning wire schemas for the Hosted verifier's generated client models."""

import json

from pydantic import BaseModel

from app.schemas.provider_environment_repair import (
    ProviderEnvironmentInventory,
    ProviderEnvironmentRepairIntent,
    ProviderEnvironmentRepairReceipt,
    ProviderEnvironmentRestore,
)


class ProviderEnvironmentContract(BaseModel):
    inventory: ProviderEnvironmentInventory
    intent: ProviderEnvironmentRepairIntent
    restore: ProviderEnvironmentRestore
    receipt: ProviderEnvironmentRepairReceipt


if __name__ == "__main__":
    print(json.dumps(ProviderEnvironmentContract.model_json_schema(), indent=2))
