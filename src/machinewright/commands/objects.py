import typer

from machinewright.commands import ui

objects = typer.Typer()


@objects.command("list", help="List all registered CAD objects")
def list_objects():
    from machinewright.registry import get_registry

    objects = get_registry().get("objects", {})
    ui.print_table(
        data=[
            {
                "Name": name,
                "Class": data["class"].__name__,
                "Params": ", ".join(data.get("params", {}).keys()),
                "Material": (
                    material.name if (material := data["class"].material) else "None"
                ),
            }
            for name, data in objects.items()
        ]
    )
