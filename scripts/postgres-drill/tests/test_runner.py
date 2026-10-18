import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "drill", Path(__file__).parents[1] / "run.py"
)
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = self.root / "readonly.env"
        self.env.write_text("PGBACKREST_STANZA=test\nPGBACKREST_REPO1_TYPE=s3\n")
        self.env.chmod(0o600)

    def test_credentials_reject_production_paths_and_nonprivate_files(self):
        self.assertEqual(drill.repository_file(str(self.env), "test"), self.env)
        self.env.chmod(0o644)
        with self.assertRaises(ValueError):
            drill.repository_file(str(self.env), "test")
        self.env.chmod(0o600)
        with self.env.open("a") as file:
            file.write("PGBACKREST_PG1_PATH=/production/data\n")
        with self.assertRaises(ValueError):
            drill.repository_file(str(self.env), "test")

    def test_atomic_status_has_no_private_permissions_or_temporary_residue(self):
        path = self.root / "test.drill.json"
        drill.publish(path, {"schema": 1, "outcome": "failed", "phase": "restore"})
        self.assertEqual(json.loads(path.read_text())["outcome"], "failed")
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        self.assertEqual(list(self.root.glob(".*.json.*")), [])

    def test_preflight_reserves_disk_before_restoring(self):
        runner = drill.Runner(
            {
                "stanza": "test",
                "database": "postgres",
                "image": "test@sha256:" + "a" * 64,
                "status_dir": str(self.root),
                "readonly_env": str(self.env),
            }
        )
        metadata = (
            [
                {
                    "name": "test",
                    "backup": [
                        {
                            "label": "20260101-010101F",
                            "error": False,
                            "timestamp": {"stop": 1},
                            "info": {"size": 1000},
                        }
                    ],
                }
            ],
            {"backup/file": {"type": "file", "size": 500}},
        )
        with (
            patch.object(runner, "metadata", return_value=metadata),
            patch.object(runner, "command", return_value=str(self.root)),
            patch.object(runner, "container") as container,
            patch.object(
                drill.shutil,
                "disk_usage",
                return_value=drill.shutil._ntuple_diskusage(4000, 1000, 3000),
            ),
        ):
            with self.assertRaisesRegex(ValueError, "headroom"):
                runner.drill({})
            container.assert_not_called()

    def test_failed_run_publishes_safe_status_and_cleans_up(self):
        config = self.root / "config.json"
        config.write_text(
            json.dumps(
                {
                    "enabled": True,
                    "stanza": "test",
                    "database": "postgres",
                    "image": "test@sha256:" + "a" * 64,
                    "status_dir": str(self.root),
                }
            )
        )
        with (
            patch.object(
                drill.Runner, "drill", side_effect=TimeoutError("private-diagnostic")
            ),
            patch.object(drill.Runner, "cleanup", return_value=True) as cleanup,
            patch.object(drill.sys, "argv", ["run.py", str(config)]),
        ):
            self.assertEqual(drill.main(), 1)
        cleanup.assert_called_once()
        file = self.root / "test.drill.json"
        status = json.loads(file.read_text())
        self.assertEqual(status["outcome"], "failed")
        self.assertGreaterEqual(status["finished_at_epoch"], status["started_at_epoch"])
        self.assertNotIn("private-diagnostic", file.read_text())


if __name__ == "__main__":
    unittest.main()
