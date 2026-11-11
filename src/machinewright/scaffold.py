"""Create standalone projects from bundled Cookiecutter starters."""

from __future__ import annotations

from importlib.metadata import distribution
import json
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory

STARTERS = ("basic",)


def _machinewright_requirement() -> str:
    installed = distribution("machinewright")
    direct_url = json.loads(installed.read_text("direct_url.json") or "{}")
    if not direct_url:
        return f"machinewright=={installed.version}"

    url = direct_url["url"]
    if vcs := direct_url.get("vcs_info"):
        url = f"{vcs['vcs']}+{url}@{vcs['commit_id']}"
    return f"machinewright @ {url}"


def create_project(name: str, output_dir: Path, starter: str) -> Path:
    """Render a bundled starter into a new directory."""
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", name):
        raise ValueError("use a lowercase project name such as indexing-table")
    if name == "machinewright":
        raise ValueError("choose a project name other than machinewright")
    if starter not in STARTERS:
        raise ValueError(f"unknown starter {starter!r}; available: {', '.join(STARTERS)}")

    output_dir = output_dir.resolve()
    target = output_dir / name
    from cookiecutter.main import cookiecutter  # type: ignore[import-untyped]

    template = Path(__file__).with_name("starters") / starter
    with TemporaryDirectory(prefix="machinewright-init-") as scratch:
        config = Path(scratch) / "cookiecutter.json"
        config.write_text(
            json.dumps({"replay_dir": scratch, "cookiecutters_dir": scratch}),
            encoding="utf-8",
        )
        # Escape the dependency for the double-quoted TOML string.
        requirement = json.dumps(_machinewright_requirement(), ensure_ascii=False)[1:-1]
        try:
            target.mkdir(parents=True)
        except FileExistsError as error:
            raise FileExistsError(f"project destination already exists: {target}") from error

        try:
            cookiecutter(
                str(template),
                no_input=True,
                accept_hooks=False,
                config_file=str(config),
                output_dir=str(output_dir),
                # This invocation owns the empty directory reserved above.
                overwrite_if_exists=True,
                extra_context={
                    "project_slug": name,
                    "machinewright_requirement": requirement,
                },
            )
        except BaseException:
            shutil.rmtree(target, ignore_errors=True)
            raise
    return target
