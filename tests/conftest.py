import pytest

from machinewright import registry


@pytest.fixture
def clean_registry():
    """
    Snapshots and restores the module-level registry dicts around a test,
    so throwaway registrations made for test purposes don't leak into
    other tests (or shadow real built-ins).
    """
    objects_snapshot = dict(registry._OBJECTS)
    assemblies_snapshot = dict(registry._ASSEMBLIES)
    registry.get_registry.cache_clear()
    try:
        yield
    finally:
        registry._OBJECTS.clear()
        registry._OBJECTS.update(objects_snapshot)
        registry._ASSEMBLIES.clear()
        registry._ASSEMBLIES.update(assemblies_snapshot)
        registry.get_registry.cache_clear()
