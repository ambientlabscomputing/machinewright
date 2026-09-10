"""Generate Python worker protocol bindings from the authoritative schema."""

from pathlib import Path
import subprocess


def main() -> None:
    root = Path(__file__).parents[1]
    output = root / "src" / "machinewright" / "protocol"
    output.mkdir(parents=True, exist_ok=True)
    (output / "__init__.py").touch()
    subprocess.run(
        [
            "protoc",
            f"--proto_path={root / 'proto'}",
            f"--python_out={output}",
            f"--pyi_out={output}",
            str(root / "proto" / "machinewright_worker.proto"),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
