"""Verify the committed OpenAPI TypeScript client matches the backend app.

This intentionally avoids starting uvicorn: importing the FastAPI app and
calling app.openapi() gives the same schema that /openapi.json serves, without
binding a port or warming runtime-only services.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    backend_dir = Path(__file__).resolve().parents[1]
    repo_root = backend_dir.parent
    generated_path = repo_root / "packages/shared/src/api/api.generated.ts"
    sys.path.insert(0, str(backend_dir))

    from app.main import app

    with tempfile.TemporaryDirectory(prefix="clawdi-openapi-") as tmp_raw:
        tmp = Path(tmp_raw)
        schema_path = tmp / "openapi.json"
        expected_path = tmp / "api.generated.ts"
        schema_path.write_text(json.dumps(app.openapi()), encoding="utf-8")

        subprocess.run(
            [
                "scripts/openapi-typescript.sh",
                str(schema_path),
                "-o",
                str(expected_path),
            ],
            cwd=repo_root,
            check=True,
        )

        committed = generated_path.read_text(encoding="utf-8")
        expected = expected_path.read_text(encoding="utf-8")
        if committed == expected:
            return 0

        diff = subprocess.run(
            [
                "diff",
                "-u",
                str(generated_path),
                str(expected_path),
            ],
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
        print(
            "packages/shared/src/api/api.generated.ts is stale. "
            "Run `bun run generate-api` against the current backend and commit the result.",
            file=sys.stderr,
        )
        print(diff.stdout, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
