"""Small portable template used for protocol and determinism verification."""

from pydantic import Field

from machinewright.contracts import Contract
from machinewright.examples.reference_hardware import SimpleAssembly
from machinewright.templates import (
    HardwareResult,
    Observable,
    ObservableKind,
    machine_template,
)


class ReferenceInputs(Contract):
    payload_kg: float = Field(default=10.0, gt=0, le=100)


@machine_template(id="machinewright.reference.simple", version="1.0.0", cacheable=True)
def reference_machine(requirements: ReferenceInputs) -> HardwareResult:
    design = SimpleAssembly().resolve(root_id="machinewright.reference.simple")
    margin = 50.0 - requirements.payload_kg
    return HardwareResult(
        design=design,
        observables=(
            Observable(
                observable_id="payload_margin",
                kind=ObservableKind.CONSTRAINT_MARGIN,
                label="Payload margin",
                value=margin,
                unit="kg",
                feasible=margin >= 0,
                source_ids=("template:machinewright.reference.simple@1.0.0",),
            ),
        ),
    )
