import fcntl
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
        lock_path = patch.object(drill, "HOST_LOCK", self.root / ".host-drill.lock")
        lock_path.start()
        self.addCleanup(lock_path.stop)
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
        directory = self.root / "status"
        directory.mkdir()
        config = self.root / "config.json"
        config.write_text(
            json.dumps(
                {
                    "enabled": True,
                    "stanza": "test",
                    "database": "postgres",
                    "image": "test@sha256:" + "a" * 64,
                    "status_dir": str(directory),
                }
            )
        )
        with (
            patch.object(
                drill.Runner, "drill", side_effect=TypeError("private-diagnostic")
            ),
            patch.object(drill.Runner, "cleanup_previous"),
            patch.object(drill.Runner, "cleanup", return_value=True) as cleanup,
            patch.object(drill.sys, "argv", ["run.py", str(config)]),
        ):
            self.assertEqual(drill.main(), 1)
        cleanup.assert_called_once()
        file = directory / "test.drill.json"
        status = json.loads(file.read_text())
        self.assertEqual(status["outcome"], "failed")
        self.assertGreaterEqual(status["finished_at_epoch"], status["started_at_epoch"])
        self.assertNotIn("private-diagnostic", file.read_text())

    def test_cleanup_only_removes_this_stanzas_generated_names(self):
        runner = drill.Runner(
            {
                "stanza": "clawdi",
                "database": "postgres",
                "image": "test@sha256:" + "a" * 64,
                "status_dir": str(self.root),
            }
        )
        own = "pg-drill-clawdi-0123456789ab"
        others = [
            "pg-drill-clawdi-hosted-0123456789ab",
            "pg-drill-clawdi-manual",
            "unrelated",
        ]
        listed = "\n".join([own, *others])

        def command(args):
            return listed if args[1] == "ps" or args[1:3] == ["volume", "ls"] else ""

        with patch.object(runner, "command", side_effect=command) as run:
            runner.cleanup_previous()
        mutations = [
            call.args[0] for call in run.call_args_list if "rm" in call.args[0]
        ]
        self.assertEqual(
            mutations,
            [
                ["docker", "rm", "--force", "--volumes", own],
                ["docker", "volume", "rm", own],
            ],
        )

    def test_host_lock_busy_times_out_without_cleanup_or_restore(self):
        directory = self.root / "cloud"
        directory.mkdir()
        config = self.root / "config.json"
        config.write_text(
            json.dumps(
                {
                    "enabled": True,
                    "stanza": "clawdi",
                    "database": "postgres",
                    "image": "test@sha256:" + "a" * 64,
                    "status_dir": str(directory),
                }
            )
        )
        with drill.HOST_LOCK.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with (
                patch.object(drill.time, "monotonic", side_effect=[0, 0, 301]),
                patch.object(drill.Runner, "cleanup_previous") as cleanup,
                patch.object(drill.Runner, "drill") as restore,
                patch.object(drill.sys, "argv", ["run.py", str(config)]),
            ):
                self.assertEqual(drill.main(), 1)
        cleanup.assert_not_called()
        restore.assert_not_called()
        status = json.loads((directory / "clawdi.drill.json").read_text())
        self.assertEqual(status["outcome"], "failed")
        self.assertEqual(status["phase"], "lock_timeout")


if __name__ == "__main__":
    unittest.main()
