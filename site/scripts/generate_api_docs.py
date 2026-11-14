"""Generate the Python API and CLI reference pages for the docs site.

Run from the Machinewright repository root (``npm run docs:api`` inside
``site/`` does this)::

    uv run --with griffe python site/scripts/generate_api_docs.py

The API reference is derived statically from the source with griffe (nothing
from the package is imported for it), driven by ``machinewright.__all__`` so it
documents exactly the supported public surface. The CLI reference walks the
Typer application, which does import ``machinewright``.
"""

from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import re
import shutil

import griffe

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "src" / "content" / "docs" / "docs" / "reference"
API_OUT = OUT / "api"

# Defining module -> (page slug, title, blurb). Anything not listed lands on
# an "Other" page so new public names are never silently dropped.
PAGES: dict[str, tuple[str, str, str]] = {
    "machinewright.objects.base": (
        "parts",
        "Parts",
        "Leaf parts: geometry, materials, ports and manufacturing facts.",
    ),
    "machinewright.assemblies.base": (
        "assemblies",
        "Assemblies",
        "Assembly definitions that declare topology through a builder.",
    ),
    "machinewright.hardware_graph": (
        "hardware-graph",
        "Hardware graph",
        "The canonical resolved graph: nodes, ports, containment, transforms and connections.",
    ),
    "machinewright.contracts": (
        "contracts",
        "Contracts",
        "Typed quantities, interfaces, and compatibility checks.",
    ),
    "machinewright.templates": (
        "templates",
        "Machine templates",
        "Portable, typed hardware functions that tools can evaluate headlessly.",
    ),
    "machinewright.evaluation": (
        "evaluation",
        "Evaluation",
        "Headless project evaluation, caching and provenance.",
    ),
    "machinewright.export_service": (
        "export",
        "Export",
        "Artifact export: STEP, STL, BOM, graph and manifest.",
    ),
    "machinewright.lib.bom": ("bom", "Bill of materials", "Structured BOM generation and writers."),
    "machinewright.lib.materials": ("materials", "Materials", "Materials and manufacturing processes."),
    "machinewright.lib.layout": ("print-layout", "Print layout", "Plate layout helpers for printed parts."),
    "machinewright.registry": ("registry", "Registry", "Registering parts and assemblies for discovery."),
    "machinewright.project": ("project", "Project config", "Loading `machinewright.toml` project descriptions."),
    "machinewright.diagnostics": ("diagnostics", "Diagnostics", "Errors, severities and validation reports."),
    "machinewright.canonical": ("canonical", "Canonical serialization", "Stable JSON and content digests."),
}


def esc(text: str) -> str:
    """Escape raw HTML angle brackets outside code spans and fences."""
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line)
        elif in_fence:
            out.append(line)
        else:
            parts = re.split(r"(`[^`]*`)", line)
            out.append(
                "".join(p if p.startswith("`") else p.replace("<", "&lt;") for p in parts)
            )
    return "\n".join(out)


def doc(obj: griffe.Object | griffe.Alias) -> str:
    try:
        d = obj.docstring
    except Exception:  # unresolved alias inside docstring lookup
        return ""
    return esc(d.value.strip()) if d else ""


def signature(obj: griffe.Object) -> str:
    if obj.is_class:
        init = obj.members.get("__init__")
        params = init.parameters if init is not None and init.is_function else None
        name = obj.name
        bases = ", ".join(str(b) for b in obj.bases)
        head = f"class {name}({bases})" if bases else f"class {name}"
        if params is None:
            return head
        shown = [p for p in params if p.name not in ("self", "cls")]
        if shown:
            body = ",\n    ".join(_param(p) for p in shown)
            return f"{head}:\n    __init__(\n    {body}\n    )"
        return head
    if obj.is_function:
        params = [p for p in obj.parameters if p.name not in ("self", "cls")]
        ret = f" -> {obj.returns}" if obj.returns is not None else ""
        if not params:
            return f"def {obj.name}(){ret}"
        body = ",\n    ".join(_param(p) for p in params)
        return f"def {obj.name}(\n    {body}\n){ret}"
    return obj.name


def _param(p: griffe.Parameter) -> str:
    s = p.name
    if p.annotation is not None:
        s += f": {p.annotation}"
    if p.default is not None:
        s += f" = {p.default}"
    return s


def members_md(cls: griffe.Class) -> str:
    lines: list[str] = []
    methods = [
        m
        for m in cls.members.values()
        if not m.is_alias
        and not m.name.startswith("_")
        and (m.is_function or m.is_attribute)
        and (m.docstring or m.is_function)
    ]
    for m in methods:
        if m.is_function:
            lines.append(f"##### `{m.name}`\n")
            lines.append(f"```python\n{signature(m)}\n```\n")
        else:
            ann = f": {m.annotation}" if m.annotation is not None else ""
            lines.append(f"##### `{m.name}`\n")
            lines.append(f"```python\n{m.name}{ann}\n```\n")
        d = doc(m)
        if d:
            lines.append(d + "\n")
    return "\n".join(lines)


def _modpath(obj: griffe.Object) -> str:
    path = obj.module.path
    return path if path.startswith("machinewright") else f"machinewright.lib.{path}"


def symbol_md(name: str, obj: griffe.Object) -> str:
    kind = "class" if obj.is_class else "function" if obj.is_function else "data"
    out = [f"### `{name}`\n", f"<p><em>{kind} in <code>{_modpath(obj)}</code></em></p>\n"]
    out.append(f"```python\n{signature(obj)}\n```\n")
    d = doc(obj)
    out.append((d if d else "_No description yet._") + "\n")
    if obj.is_class:
        out.append(members_md(obj))
    return "\n".join(out)


def frontmatter(title: str, description: str, order: int | None = None) -> str:
    fm = ["---", f"title: {json.dumps(title)}", f"description: {json.dumps(description)}"]
    if order is not None:
        fm += ["sidebar:", f"  order: {order}"]
    fm.append("---\n")
    return "\n".join(fm)


def gen_api() -> list[tuple[str, str]]:
    pkg = griffe.load("machinewright", search_paths=[str(ROOT / "src")])
    # ``lib`` is a namespace package, so griffe does not descend into it on
    # its own; load the modules the public API re-exports from it directly.
    extras = {
        f"machinewright.lib.{m}": griffe.load(m, search_paths=[str(ROOT / "src" / "machinewright" / "lib")])
        for m in ("bom", "layout", "materials")
    }
    names = _all_names(pkg)
    grouped: dict[str, list[tuple[str, griffe.Object]]] = defaultdict(list)
    for name in sorted(set(names), key=str.lower):
        member = pkg.members[name]
        try:
            target = member.final_target
            module_path = target.module.path
        except Exception:
            module_path, _, attr = member.target_path.rpartition(".")
            if module_path not in extras:
                print(f"skip {name}: cannot resolve {member.target_path}")
                continue
            target = extras[module_path][attr]
        grouped[module_path].append((name, target))

    index: list[tuple[str, str]] = []
    other: list[tuple[str, griffe.Object]] = []
    order = 1
    for module_path, (slug, title, blurb) in PAGES.items():
        items = grouped.pop(module_path, [])
        if not items:
            continue
        body = [frontmatter(title, blurb, order), blurb + "\n"]
        body += [symbol_md(n, o) for n, o in items]
        (API_OUT / f"{slug}.md").write_text("\n".join(body), encoding="utf-8")
        index.append((slug, title))
        order += 1
    for items in grouped.values():
        other += items
    if other:
        body = [frontmatter("Other", "Additional public names.", order), "Additional public names.\n"]
        body += [symbol_md(n, o) for n, o in sorted(other, key=lambda t: t[0].lower())]
        (API_OUT / "other.md").write_text("\n".join(body), encoding="utf-8")
        index.append(("other", "Other"))
    return index


def _all_names(pkg: griffe.Module) -> list[str]:
    value = pkg.exports
    return [str(v) for v in value] if value else []


def gen_cli() -> None:
    import click
    import typer.main

    from machinewright.main import app

    root = typer.main.get_command(app)
    lines = [
        frontmatter("CLI reference", "Every `machinewright` command, generated from the Typer app.", 100),
        "The `machinewright` command is installed with the Python package. "
        "Run any command with `--help` for the same text offline.\n",
    ]

    def walk(cmd: click.Command, path: list[str], depth: int) -> None:
        ctx = click.Context(cmd, info_name=path[-1], parent=None)
        if path:
            lines.append(f"{'#' * min(depth, 4)} `{' '.join(path)}`\n")
        help_text = (cmd.help or "").strip()
        if help_text:
            lines.append(esc(help_text) + "\n")
        usage = cmd.get_usage(ctx).replace("Usage: ", "")
        lines.append(f"```text\n{usage}\n```\n")
        params = [p for p in cmd.get_params(ctx) if p.name != "help"]
        if params:
            lines.append("| Parameter | Description |\n| --- | --- |")
            for p in params:
                opts = getattr(p, "opts", None)
                label = ", ".join(opts) if opts else p.name.upper()
                hlp = (getattr(p, "help", "") or "").replace("\n", " ").replace("|", "\\|")
                default = getattr(p, "default", None)
                if default not in (None, (), [], "") and not callable(default):
                    hlp += f" Default: `{default}`."
                lines.append(f"| `{label}` | {esc(hlp)} |")
            lines.append("")
        if isinstance(cmd, click.Group):
            for name in sorted(cmd.commands):
                walk(cmd.commands[name], [*path, name], depth + 1)

    walk(root, ["machinewright"], 2)
    (OUT / "cli.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    API_OUT.mkdir(parents=True)
    index = gen_api()
    gen_cli()
    print(f"wrote {len(index)} API pages + CLI reference to {OUT}")


if __name__ == "__main__":
    main()
