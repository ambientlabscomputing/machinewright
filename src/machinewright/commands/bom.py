"""`machinewright bom`: purchased-parts sourcing for a project's BOM.

Reads the BOM every evaluation writes (`.machinewright/output/assembly-*.bom.json`,
or `--bom`) and the project's `bom-procurement.json` (see `lib.procurement`).
Every command takes `--json` so agents get structured output.
"""

from __future__ import annotations

import json
from pathlib import Path

import typer

from machinewright.lib.bom import BOM
from machinewright.lib.procurement import (
    OrderStatus,
    load_procurement,
    part_name,
    resolve_line_id,
    save_procurement,
    short_id,
    sourcing_lines,
    sourcing_totals,
    sync_procurement,
    update_entry,
    write_sourcing_csv,
)

bom = typer.Typer()

_Root = typer.Option(Path("."), "--root", help="Project root (holds pyproject.toml)")
_BomPath = typer.Option(
    None,
    "--bom",
    help="BOM JSON to use. Default: the newest .machinewright/output/assembly-*.bom.json",
)


def _load_bom(root: Path, path: Path | None) -> BOM:
    if path is None:
        candidates = sorted(
            (root / ".machinewright" / "output").glob("assembly-*.bom.json"),
            key=lambda item: item.stat().st_mtime,
        )
        if not candidates:
            raise typer.BadParameter(
                "no BOM found — evaluate the project first (the app does this on open), "
                "or pass --bom"
            )
        path = candidates[-1]
    return BOM.model_validate_json(path.read_text(encoding="utf-8"))


@bom.command("list")
def list_lines(
    root: Path = _Root,
    bom_path: Path | None = _BomPath,
    all_parts: bool = typer.Option(False, "--all", help="Include non-purchased parts"),
    unsourced: bool = typer.Option(
        False, "--unsourced", help="Only lines still missing a supplier or price"
    ),
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output"),
) -> None:
    """List purchased BOM lines with their sourcing status."""
    bom_data = _load_bom(root, bom_path)
    procurement = sync_procurement(bom_data, load_procurement(root))
    lines = sourcing_lines(bom_data, procurement, purchased_only=not all_parts)
    if unsourced:
        lines = [line for line in lines if not line.sourced]
    totals = sourcing_totals(lines)
    if as_json:
        typer.echo(
            json.dumps(
                {
                    "currency": procurement.currency,
                    "lines": [line.model_dump(mode="json") for line in lines],
                    "totals": totals.model_dump(mode="json"),
                },
                indent=2,
            )
        )
        return
    for line in lines:
        price = "-" if line.entry.unit_cost is None else f"{line.entry.unit_cost:.2f}"
        typer.echo(
            f"{short_id(line.line_id)}  {part_name(line.definition_id):<28} "
            f"x{line.order_quantity:<4} {line.entry.status.value:<9} "
            f"{line.entry.supplier or '-':<14} {price:>9}  "
            f"{line.manufacturer} {line.part_number}".rstrip()
        )
    typer.echo(
        f"{totals.lines} lines · {totals.units} units · "
        f"{totals.cost:.2f} {procurement.currency} priced · {totals.unpriced} unpriced"
    )


@bom.command("set")
def set_entry(
    line_id: str = typer.Argument(..., help="BOM line id, or a unique prefix of it"),
    root: Path = _Root,
    bom_path: Path | None = _BomPath,
    supplier: str | None = None,
    sku: str | None = None,
    url: str | None = None,
    unit_cost: float | None = typer.Option(None, min=0),
    spares: int | None = typer.Option(None, min=0),
    status: OrderStatus | None = None,
    notes: str | None = None,
) -> None:
    """Record sourcing details for one BOM line (only the given fields change)."""
    bom_data = _load_bom(root, bom_path)
    try:
        full_id = resolve_line_id(bom_data, line_id)
    except KeyError as error:
        raise typer.BadParameter(str(error.args[0])) from error
    changes = {
        key: value
        for key, value in {
            "supplier": supplier,
            "sku": sku,
            "url": url,
            "unit_cost": unit_cost,
            "spares": spares,
            "status": status,
            "notes": notes,
        }.items()
        if value is not None
    }
    if not changes:
        raise typer.BadParameter("nothing to set — pass at least one field")
    synced = sync_procurement(bom_data, load_procurement(root))
    save_procurement(root, update_entry(synced, full_id, **changes))
    typer.echo(full_id)


@bom.command("sync")
def sync(root: Path = _Root, bom_path: Path | None = _BomPath) -> None:
    """Prefill bom-procurement.json: one blank, readable entry per purchased part.

    Existing sourcing data is kept. The app does this whenever the BOM tab opens.
    """
    bom_data = _load_bom(root, bom_path)
    synced = sync_procurement(bom_data, load_procurement(root))
    path = save_procurement(root, synced)
    todo = sum(1 for line in sourcing_lines(bom_data, synced) if not line.sourced)
    typer.echo(f"{path} — {todo} lines still need sourcing")


@bom.command("export")
def export_csv(
    location: Path,
    root: Path = _Root,
    bom_path: Path | None = _BomPath,
    all_parts: bool = typer.Option(False, "--all", help="Include non-purchased parts"),
) -> None:
    """Write the purchased-parts BOM with sourcing details as CSV."""
    bom_data = _load_bom(root, bom_path)
    procurement = load_procurement(root)
    lines = sourcing_lines(bom_data, procurement, purchased_only=not all_parts)
    location.parent.mkdir(parents=True, exist_ok=True)
    write_sourcing_csv(lines, location, procurement.currency)
    typer.echo(str(location))
