variable "E2E_ARTIFACT_DIR" {
  default = ""
}

variable "E2E_IMAGE_PREFIX" {
  default = "clawdi-managed-whatsapp-native-e2e"
}

group "default" {
  targets = ["openclaw", "hermes"]
}

target "_common" {
  context    = "."
  dockerfile = "packages/cli/tests/fixtures/managed-whatsapp-native-e2e/Dockerfile"
  contexts = {
    e2e_artifacts = E2E_ARTIFACT_DIR
  }
}

target "openclaw" {
  inherits = ["_common"]
  target   = "openclaw"
  tags     = ["${E2E_IMAGE_PREFIX}:openclaw-local"]
}

target "hermes" {
  inherits = ["_common"]
  target   = "hermes"
  tags     = ["${E2E_IMAGE_PREFIX}:hermes-local"]
}
