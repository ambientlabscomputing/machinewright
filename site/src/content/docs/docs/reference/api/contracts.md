---
title: "Contracts"
description: "Typed quantities, interfaces, and compatibility checks."
sidebar:
  order: 4
---

Typed quantities, interfaces, and compatibility checks.

### `ConnectorInterface`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class ConnectorInterface(InterfaceBase)
```

_No description yet._


### `DistributorSkuIdentity`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class DistributorSkuIdentity(Contract)
```

_No description yet._


### `DutyCycleRating`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class DutyCycleRating(Contract)
```

Generic duty capability used for compatibility screening.

Qualification evidence and machine-specific load spectra intentionally remain
outside Machinewright.

##### `physical_dimensions`

```python
def physical_dimensions() -> DutyCycleRating
```

### `ElectricalInterface`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class ElectricalInterface(InterfaceBase)
```

_No description yet._

##### `electrical_dimensions`

```python
def electrical_dimensions() -> ElectricalInterface
```

### `evaluate_motor_compatibility`

<p><em>function in <code>machinewright.contracts</code></em></p>

```python
def evaluate_motor_compatibility(
    spec: MotorSpec,
    requirement: MotorRequirement
) -> ValidationReport
```

_No description yet._

### `FeedbackInterface`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class FeedbackInterface(InterfaceBase)
```

_No description yet._


### `FinishRequirement`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class FinishRequirement(Contract)
```

_No description yet._


### `InspectionRequirement`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class InspectionRequirement(Contract)
```

_No description yet._


### `interfaces_compatible`

<p><em>function in <code>machinewright.contracts</code></em></p>

```python
def interfaces_compatible(
    candidate: InterfaceSpec,
    required: InterfaceSpec,
    require_identity: bool = True
) -> bool
```

_No description yet._

### `ManufacturerPartIdentity`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class ManufacturerPartIdentity(Contract)
```

_No description yet._


### `MaterialSpec`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class MaterialSpec(Contract)
```

_No description yet._

##### `density_dimension`

```python
def density_dimension() -> MaterialSpec
```

### `MechanicalMountInterface`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class MechanicalMountInterface(InterfaceBase)
```

_No description yet._


### `MotorOperatingPoint`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class MotorOperatingPoint(Contract)
```

A guaranteed torque envelope at or below a stated motor speed.

##### `physical_dimensions`

```python
def physical_dimensions() -> MotorOperatingPoint
```

### `MotorRequirement`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class MotorRequirement(Contract)
```

_No description yet._


### `MotorSpec`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class MotorSpec(Contract)
```

_No description yet._

##### `physical_dimensions`

```python
def physical_dimensions() -> MotorSpec
```

### `ProcessSpec`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class ProcessSpec(Contract)
```

_No description yet._


### `Quantity`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class Quantity(BaseModel)
```

_No description yet._

##### `finite`

```python
def finite(
    value: Decimal
) -> Decimal
```

##### `canonical_value`

```python
def canonical_value() -> Decimal
```

##### `to`

```python
def to(
    unit: Unit
) -> Quantity
```

### `QuantityConstraint`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class QuantityConstraint(Contract)
```

_No description yet._

##### `bounds`

```python
def bounds() -> QuantityConstraint
```

### `ShaftInterface`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class ShaftInterface(InterfaceBase)
```

_No description yet._

##### `length_dimensions`

```python
def length_dimensions() -> ShaftInterface
```

### `ThermalInterface`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class ThermalInterface(InterfaceBase)
```

_No description yet._

##### `temperature_dimensions`

```python
def temperature_dimensions() -> ThermalInterface
```

### `Tolerance`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class Tolerance(Contract)
```

_No description yet._

##### `compatible`

```python
def compatible() -> Tolerance
```

##### `add`

```python
def add(
    other: Tolerance
) -> Tolerance
```

##### `subtract`

```python
def subtract(
    other: Tolerance
) -> Tolerance
```

### `Unit`

<p><em>class in <code>machinewright.contracts</code></em></p>

```python
class Unit(StrEnum)
```

_No description yet._

