"""Sourcing data for the purchased lines of a BOM.

The BOM (`lib.bom`) says *what* to buy; this module records *where and at what
price*, in `bom-procurement.json` at the project root so it is committed with the
design. Entries are keyed by `BOMLineV1.line_id` (a digest of part definition,
revision and parameters), so they survive unrelated design edits; entries for
parts that leave the design are kept in case they return.

The native app, the CLI (`machinewright bom ...`) and agents all go through this
module, so there is exactly one reader, writer and merge.
"""

from __future__ import annotations

import csv
from decimal import Decimal
from enum import StrEnum
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from machinewright.contracts import Contract
from machinewright.lib.bom import BOM, BOMLineV1

PROCUREMENT_FILE = "bom-procurement.json"


class OrderStatus(StrEnum):
    TO_ORDER = "to_order"
    ORDERED = "ordered"
    RECEIVED = "received"
    ON_HAND = "on_hand"


class ProcurementEntry(Contract):
    supplier: str = ""
    sku: str = ""
    url: str = ""
    # Price of one unit in the file's currency; None when unknown.
    # `unitCost` is accepted for files written by early app versions.
    unit_cost: float | None = Field(
        default=None, ge=0, validation_alias=AliasChoices("unit_cost", "unitCost")
    )
    # Extra units to buy beyond the design's need (spare fasteners, losses).
    spares: int = Field(default=0, ge=0)
    status: OrderStatus = OrderStatus.TO_ORDER
    notes: str = ""

    @property
    def is_empty(self) -> bool:
        return self == EMPTY_ENTRY


EMPTY_ENTRY = ProcurementEntry()


class LineContext(Contract):
    """What a line is, copied from the BOM so the file reads on its own.

    Derived data: refreshed by `sync_procurement` and never read back as input.
    """

    part: str
    description: str = ""
    quantity: int | None = None
    instances: tuple[str, ...] = ()
    material: str | None = None
    manufacturer: str = ""
    part_number: str = ""
    in_design: bool = True


class ProcurementFile(Contract):
    currency: str = "USD"
    # Sourcing inputs, keyed by `BOMLineV1.line_id`.
    lines: dict[str, ProcurementEntry] = Field(default_factory=dict)
    # Descriptions of those lines (derived; see `LineContext`).
    context: dict[str, LineContext] = Field(default_factory=dict)


# Fields an order needs before it can be placed, in the order a person fills them in.
_REQUIRED = ("supplier", "sku", "unit_cost")
_SETTLED = (OrderStatus.RECEIVED, OrderStatus.ON_HAND)


def missing_fields(entry: ProcurementEntry, *, in_design: bool = True) -> list[str]:
    """What is still needed to place this order; empty once sourced, bought, or no longer used."""
    if not in_design or entry.status in _SETTLED:
        return []
    return [name for name in _REQUIRED if getattr(entry, name) in ("", None)]


_INSTRUCTIONS = (
    "Sourcing for this design's purchased parts. For each line whose `needs` is not empty, "
    "fill in the fields it lists (supplier, sku, unit_cost; url and notes help), then set "
    "`status` as the order progresses: to_order, ordered, received, on_hand. "
    "part, description, quantity, instances, material, manufacturer, part_number, in_design "
    "and needs are refreshed from the design automatically — edit the rest."
)


class ProcurementRecord(BaseModel):
    """One line as written to disk: a readable header, derived context, then inputs."""

    model_config = ConfigDict(extra="forbid")

    part: str
    description: str = ""
    needs: list[str] = Field(default_factory=list)
    status: OrderStatus = OrderStatus.TO_ORDER
    quantity: int | None = None
    supplier: str = ""
    sku: str = ""
    url: str = ""
    unit_cost: float | None = Field(default=None, ge=0)
    spares: int = Field(default=0, ge=0)
    notes: str = ""
    instances: list[str] = Field(default_factory=list)
    material: str | None = None
    manufacturer: str = ""
    part_number: str = ""
    in_design: bool = True
    line_id: str


class ProcurementDocument(BaseModel):
    """The shape of `bom-procurement.json`."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"] = "1.0"
    instructions: str = _INSTRUCTIONS
    currency: str = "USD"
    lines: list[ProcurementRecord] = Field(default_factory=list)


_INPUT_FIELDS = ("supplier", "sku", "url", "unit_cost", "spares", "status", "notes")


def procurement_path(project_root: str | Path) -> Path:
    return Path(project_root) / PROCUREMENT_FILE


def parse_procurement(text: str) -> ProcurementFile:
    """Parse the file's JSON. Also reads the earlier `{line_id: entry}` dict layout."""
    raw = json.loads(text)
    entries: dict[str, ProcurementEntry] = {}
    context: dict[str, LineContext] = {}
    rows = raw.get("lines", [])
    if isinstance(rows, dict):  # earlier layout: no context
        rows = [{"line_id": key, **value} for key, value in rows.items()]
    for row in rows:
        line_id = row["line_id"]
        entries[line_id] = ProcurementEntry.model_validate(
            {key: row[key] for key in (*_INPUT_FIELDS, "unitCost") if key in row},
            strict=False,  # file values are JSON text (status is a string)
        )
        if "part" in row:
            context[line_id] = LineContext.model_validate(
                {
                    key: row[key]
                    for key in LineContext.model_fields
                    if key in row and key != "schema_version"
                },
                strict=False,  # JSON arrays arrive as lists
            )
    return ProcurementFile(
        currency=raw.get("currency", "USD"), lines=entries, context=context
    )


def load_procurement(project_root: str | Path) -> ProcurementFile:
    """Read the project's procurement file; a missing file is an empty one."""
    path = procurement_path(project_root)
    if not path.exists():
        return ProcurementFile()
    return parse_procurement(path.read_text(encoding="utf-8"))


def serialize_procurement(data: ProcurementFile) -> str:
    """Readable, diff-friendly JSON: lines in use first, by part name.

    Lines in the design are always written (blank ones are the to-do list);
    lines that left the design are kept only when they hold sourcing data.
    """
    records = []
    for line_id in sorted({*data.lines, *data.context}):
        entry = data.lines.get(line_id, EMPTY_ENTRY)
        ctx = data.context.get(line_id, LineContext(part=line_id.split(":")[-1][:12]))
        if entry.is_empty and not (line_id in data.context and ctx.in_design):
            continue
        records.append(
            ProcurementRecord(
                part=ctx.part,
                description=ctx.description,
                needs=missing_fields(entry, in_design=ctx.in_design),
                status=entry.status,
                quantity=ctx.quantity,
                supplier=entry.supplier,
                sku=entry.sku,
                url=entry.url,
                unit_cost=entry.unit_cost,
                spares=entry.spares,
                notes=entry.notes,
                instances=list(ctx.instances),
                material=ctx.material,
                manufacturer=ctx.manufacturer,
                part_number=ctx.part_number,
                in_design=ctx.in_design,
                line_id=line_id,
            )
        )
    records.sort(key=lambda r: (not r.in_design, r.part, r.line_id))
    document = ProcurementDocument(currency=data.currency, lines=records)
    return (
        json.dumps(document.model_dump(mode="json"), indent=2, ensure_ascii=False)
        + "\n"
    )


def save_procurement(project_root: str | Path, data: ProcurementFile) -> Path:
    """Write atomically, so a crash or a concurrent reader never sees half a file."""
    path = procurement_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, scratch = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            output.write(serialize_procurement(data))
        os.replace(scratch, path)
    except BaseException:
        Path(scratch).unlink(missing_ok=True)
        raise
    return path


def update_entry(
    data: ProcurementFile, line_id: str, **changes: object
) -> ProcurementFile:
    """Return `data` with `changes` merged into the entry for `line_id`."""
    current = data.lines.get(line_id, EMPTY_ENTRY)
    merged = ProcurementEntry.model_validate(
        {**current.model_dump(mode="python"), **changes}, strict=False
    )
    return data.model_copy(update={"lines": {**data.lines, line_id: merged}})


def part_name(definition_id: str) -> str:
    """`parts.common.shim-5x8x0.25` -> `shim-5x8x0.25`: drop the module path, keep dotted names whole."""
    segments = definition_id.split(".")
    start = 0
    while (
        start < len(segments) - 1
        and segments[start].isidentifier()
        and segments[start].islower()
    ):
        start += 1
    return ".".join(segments[start:])


def line_context(line: BOMLineV1) -> LineContext:
    return LineContext(
        part=part_name(line.definition_id),
        description=" · ".join(
            f"{name}={value}"
            for name, value in line.parameters.items()
            if name != "definition_id" and isinstance(value, str | int | float | bool)
        ),
        quantity=int(line.quantity),
        instances=tuple(node.rsplit("/", 1)[-1] for node in line.source_instances),
        material=line.material,
        manufacturer=(line.manufacturer_part or {}).get("manufacturer", ""),
        part_number=(line.manufacturer_part or {}).get("part_number", ""),
    )


def sync_procurement(bom: BOM, data: ProcurementFile) -> ProcurementFile:
    """Prefill: every purchased line gets an entry, and context follows the design.

    Sourcing inputs already recorded are never touched. Lines that left the design
    are marked `in_design: false`, not deleted.
    """
    current = {line.line_id: line for line in purchased_lines(bom)}
    context = {
        line_id: ctx.model_copy(update={"in_design": False})
        for line_id, ctx in data.context.items()
        if line_id not in current
    }
    for line_id, line in current.items():
        context[line_id] = line_context(line)
    lines = {**{line_id: EMPTY_ENTRY for line_id in current}, **data.lines}
    return data.model_copy(update={"lines": lines, "context": context})


# --- BOM x procurement ---------------------------------------------------------------


def is_purchased(line: BOMLineV1) -> bool:
    """Purchased lines are bought, not made: material process PURCHASED (or process id)."""
    if line.material_process is not None:
        return line.material_process == "PURCHASED"
    return (line.process or {}).get("process_id") == "purchased"


def purchased_lines(bom: BOM) -> tuple[BOMLineV1, ...]:
    return tuple(line for line in bom.lines if is_purchased(line))


def resolve_line_id(bom: BOM, prefix: str) -> str:
    """Full `line_id` for an exact id or a unique prefix, so callers can type short ids."""
    matches = [
        line.line_id
        for line in bom.lines
        if line.line_id.startswith(prefix)
        or line.line_id.split(":")[-1].startswith(prefix)
    ]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise KeyError(f"no BOM line matches {prefix!r}")
    raise KeyError(f"{prefix!r} is ambiguous ({len(matches)} BOM lines match)")


def short_id(line_id: str) -> str:
    """The first 12 hex digits of a line id: short, and enough to pass back to `resolve_line_id`."""
    return line_id.split(":")[-1][:12]


class SourcingLine(Contract):
    """One BOM line joined with its sourcing entry."""

    line_id: str
    definition_id: str
    parameters: dict[str, Any]
    manufacturer: str = ""
    part_number: str = ""
    material: str | None = None
    quantity: int
    spares: int
    order_quantity: int
    entry: ProcurementEntry
    extended_cost: float | None
    source_instances: tuple[str, ...]

    @property
    def sourced(self) -> bool:
        """Enough to place an order: a supplier and a price."""
        return bool(self.entry.supplier) and self.entry.unit_cost is not None


def sourcing_lines(
    bom: BOM, data: ProcurementFile, *, purchased_only: bool = True
) -> list[SourcingLine]:
    lines = purchased_lines(bom) if purchased_only else bom.lines
    merged = []
    for line in lines:
        entry = data.lines.get(line.line_id, EMPTY_ENTRY)
        quantity = int(line.quantity)
        order_quantity = quantity + entry.spares
        merged.append(
            SourcingLine(
                line_id=line.line_id,
                definition_id=line.definition_id,
                parameters=line.parameters,
                manufacturer=(line.manufacturer_part or {}).get("manufacturer", ""),
                part_number=(line.manufacturer_part or {}).get("part_number", ""),
                material=line.material,
                quantity=quantity,
                spares=entry.spares,
                order_quantity=order_quantity,
                entry=entry,
                extended_cost=(
                    None
                    if entry.unit_cost is None
                    else float(Decimal(str(entry.unit_cost)) * order_quantity)
                ),
                source_instances=line.source_instances,
            )
        )
    return merged


class SourcingTotals(Contract):
    lines: int
    units: int
    cost: float  # priced lines only
    unpriced: int
    by_status: dict[str, int]


def sourcing_totals(lines: list[SourcingLine]) -> SourcingTotals:
    by_status = {status.value: 0 for status in OrderStatus}
    for line in lines:
        by_status[line.entry.status.value] += 1
    return SourcingTotals(
        lines=len(lines),
        units=sum(line.order_quantity for line in lines),
        cost=float(sum(Decimal(str(line.extended_cost or 0)) for line in lines)),
        unpriced=sum(1 for line in lines if line.entry.unit_cost is None),
        by_status=by_status,
    )


def write_sourcing_csv(
    lines: list[SourcingLine], location: str | Path, currency: str = "USD"
) -> None:
    fields = (
        "part",
        "manufacturer",
        "part_number",
        "quantity",
        "spares",
        "order_quantity",
        "supplier",
        "sku",
        "url",
        f"unit_cost_{currency.lower()}",
        f"extended_cost_{currency.lower()}",
        "status",
        "notes",
        "line_id",
    )
    with Path(location).open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for line in lines:
            writer.writerow(
                {
                    "part": part_name(line.definition_id),
                    "manufacturer": line.manufacturer,
                    "part_number": line.part_number,
                    "quantity": line.quantity,
                    "spares": line.spares,
                    "order_quantity": line.order_quantity,
                    "supplier": line.entry.supplier,
                    "sku": line.entry.sku,
                    "url": line.entry.url,
                    f"unit_cost_{currency.lower()}": ""
                    if line.entry.unit_cost is None
                    else line.entry.unit_cost,
                    f"extended_cost_{currency.lower()}": ""
                    if line.extended_cost is None
                    else line.extended_cost,
                    "status": line.entry.status.value,
                    "notes": line.entry.notes,
                    "line_id": line.line_id,
                }
            )
