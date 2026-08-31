from machinewright import (
    ConnectionKind,
    ContainmentEdge,
    FeedbackInterface,
    PortInstance,
    PortRole,
)
from tests.fixtures.simple_assembly import SimpleAssembly


def _codes(graph) -> set[str]:
    return {item.code for item in graph.validate_graph().diagnostics}


def test_containment_cycle_is_diagnosed():
    graph = SimpleAssembly().resolve(root_id="fixture").graph
    broken = graph.model_copy(
        update={
            "containment": graph.containment
            + (
                ContainmentEdge(
                    edge_id="cycle",
                    parent_node_id="fixture/base_plate",
                    child_node_id="fixture",
                ),
            )
        }
    )
    assert "graph.containment_cycle" in _codes(broken)


def test_multiple_parent_is_diagnosed():
    graph = SimpleAssembly().resolve(root_id="fixture").graph
    broken = graph.model_copy(
        update={
            "containment": graph.containment
            + (
                ContainmentEdge(
                    edge_id="second-parent",
                    parent_node_id="fixture/top_pin",
                    child_node_id="fixture/base_plate",
                ),
            )
        }
    )
    assert "graph.multiple_parents" in _codes(broken)


def test_dangling_connection_is_diagnosed():
    graph = SimpleAssembly().resolve(root_id="fixture").graph
    edge = graph.connections[0].model_copy(update={"target_port_id": "missing#port"})
    broken = graph.model_copy(update={"connections": (edge, *graph.connections[1:])})
    assert "graph.connection_dangling" in _codes(broken)


def test_incompatible_connection_is_diagnosed():
    graph = SimpleAssembly().resolve(root_id="fixture").graph
    target = next(port for port in graph.ports if port.port_id.endswith("#signal"))
    incompatible = target.model_copy(
        update={
            "interface": FeedbackInterface(
                interface_id="signal",
                feedback_type="temperature",
                protocol="i2c",
            )
        }
    )
    ports = tuple(
        incompatible if port.port_id == target.port_id else port for port in graph.ports
    )
    broken = graph.model_copy(update={"ports": ports})
    assert "graph.connection_incompatible" in _codes(broken)


def test_required_port_and_cardinality_are_diagnosed():
    graph = SimpleAssembly().resolve(root_id="fixture").graph
    extra = PortInstance(
        port_id="fixture/base_plate#required-extra",
        node_id="fixture/base_plate",
        instance_key="required-extra",
        interface=FeedbackInterface(
            interface_id="extra", feedback_type="position", protocol="spi"
        ),
        required=True,
        max_connections=1,
        role=PortRole.SOURCE,
    )
    duplicated = graph.connections[0].model_copy(update={"edge_id": "duplicate-load"})
    broken = graph.model_copy(
        update={
            "ports": (*graph.ports, extra),
            "connections": (*graph.connections, duplicated),
        }
    )
    assert {"graph.port_required", "graph.port_cardinality"} <= _codes(broken)


def test_connection_kind_filter_is_deterministic():
    graph = SimpleAssembly().resolve(root_id="fixture").graph
    assert graph.neighbors("fixture/base_plate", kind=ConnectionKind.MECHANICAL) == (
        "fixture/top_pin",
    )
