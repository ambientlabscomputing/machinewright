"""
Discovers and imports the modules a consuming project registers its own
PartDefinition/AssemblyDefinition subclasses in, so the CLI can list/export them
alongside machinewright's built-ins.

Two sources, merged: a `[tool.machinewright] modules = [...]` list read from
`pyproject.toml` in the current working directory, and any `--module`/`-m`
flags passed on the command line. Only the CWD's pyproject.toml is
consulted -- no upward/ancestor search -- to avoid silently picking up an
unrelated project's config.
"""

import importlib
from pathlib import Path
import tomllib

import typer


def _configured_modules(cwd: Path) -> list[str]:
    pyproject = cwd / "pyproject.toml"
    if not pyproject.exists():
        return []
    data = tomllib.loads(pyproject.read_text())
    return data.get("tool", {}).get("machinewright", {}).get("modules", [])


def load_modules(extra: list[str]) -> None:
    modules = list(_configured_modules(Path.cwd()))
    for module in extra:
        if module not in modules:
            modules.append(module)

    for module in modules:
        try:
            importlib.import_module(module)
        except Exception as exc:
            typer.echo(
                f"Failed to import module {module!r} from "
                f"[tool.machinewright] modules: {exc}",
                err=True,
            )
            raise typer.Exit(code=1) from exc
