from tests.fixtures.simple_assembly import SimpleAssembly


def test_simple_assembly_cad_produces_geometry():
    inst = SimpleAssembly()
    cad = inst.cad()
    assert cad.val().Volume() > 0


def test_simple_assembly_exploded_moves_children_apart():
    inst = SimpleAssembly()

    flat = inst.assemble()
    exploded = inst.assemble_exploded(spacing=50.0, nested=False)

    flat_centers = [
        c.obj.val().located(c.loc).BoundingBox().center.z
        for c in flat.children
        if c.obj is not None
    ]
    exploded_centers = [
        c.obj.val().located(c.loc).BoundingBox().center.z
        for c in exploded.children
        if c.obj is not None
    ]

    assert max(exploded_centers) - min(exploded_centers) > max(flat_centers) - min(
        flat_centers
    )


def test_simple_assembly_exploded_nested_recurses_into_pin_pair():
    inst = SimpleAssembly()

    exploded = inst.assemble_exploded(spacing=50.0, nested=True)

    pin_pair = next(c for c in exploded.children if c.name == "pin_pair")
    assert pin_pair.obj is None

    inner_zs = [
        c.obj.val().located(c.loc).BoundingBox().center.z for c in pin_pair.children
    ]
    assert max(inner_zs) - min(inner_zs) == 50.0


def test_simple_assembly_cad_exploded_true_returns_workplane():
    inst = SimpleAssembly()
    cad = inst.cad(exploded=True, spacing=50.0, nested=True)
    assert cad.val().Volume() > 0
