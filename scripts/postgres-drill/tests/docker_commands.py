"""Emit production Docker commands; run.sh executes them against the local fixture.

Only the command transport is replaced. Runner still chooses the image user,
credentials, scratch ownership and offline boundaries. Actual pgBackRest and
PostgreSQL processes must succeed, including metadata with the root-default image.
"""

import os
import runpy
import shlex
from pathlib import Path

directory = Path(__file__).parents[1]
Runner = runpy.run_path(str(directory / "run.py"))["Runner"]
project = os.environ["DRILL_TEST_PROJECT"]


class Commands(Runner):
    def command(self, args: list[str], *, stdin: str | None = None) -> str:
        # The production mount/user/entrypoint are unchanged. Add only a local,
        # read-only repository and disable networking for this hermetic fixture.
        args[2:2] = [
            "--mount",
            f"type=volume,src={project}_fixture,dst=/fixture,readonly",
        ]
        if "--network=none" not in args:
            args.insert(2, "--network=none")
        command = shlex.join(args)
        if stdin is not None:
            command = f"printf %s {shlex.quote(stdin)} | {command}"
        print(f"{command} >/dev/null")
        # metadata() parses the transport result while generating both commands;
        # the real commands below must independently exit successfully.
        return "null"


runner = Commands(
    {
        "stanza": "drill-test",
        "database": "postgres",
        "image": os.environ["POSTGRES_DRILL_IMAGE"],
        "status_dir": "/tmp",
    }
)
runner.name = f"{project}-reader"
runner.volume = f"{project}_scratch"
env = Path(os.environ["DRILL_TEST_ENV"])
target = Path("/fixture/target").read_text().strip()
backup = Path("/fixture/backup").read_text().strip()
runner.metadata(env)
runner.prepare_scratch()
runner.container(
    ["bash", "-s", "--", target, backup, "67108864"],
    env_file=env,
    stdin=(directory / "fetch.sh").read_text(),
)
runner.container(
    ["sh", "-c", "cat > /scratch/sanity.sql"],
    offline=True,
    stdin="SELECT count(*) = 2 AND max(id) = 2 FROM drill_rows;\n",
)
runner.container(
    ["bash", "-s", "--", "postgres", target, "3600"],
    offline=True,
    user="postgres",
    stdin='test -z "${PGBACKREST_REPO1_S3_KEY:-}"\n'
    + (directory / "check.sh").read_text(),
)
