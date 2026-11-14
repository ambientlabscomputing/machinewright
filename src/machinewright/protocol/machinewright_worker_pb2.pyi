from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Hello(_message.Message):
    __slots__ = ("protocol_version", "capabilities")
    PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    protocol_version: int
    capabilities: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, protocol_version: _Optional[int] = ..., capabilities: _Optional[_Iterable[str]] = ...) -> None: ...

class SourceOverlay(_message.Message):
    __slots__ = ("relative_path", "content")
    RELATIVE_PATH_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    relative_path: str
    content: bytes
    def __init__(self, relative_path: _Optional[str] = ..., content: _Optional[bytes] = ...) -> None: ...

class EvaluateProject(_message.Message):
    __slots__ = ("session_id", "generation", "project_root", "template_id", "template_version", "inputs_json", "output_directory", "overlays", "environment_digest")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    PROJECT_ROOT_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_ID_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_VERSION_FIELD_NUMBER: _ClassVar[int]
    INPUTS_JSON_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    OVERLAYS_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENT_DIGEST_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    project_root: str
    template_id: str
    template_version: str
    inputs_json: bytes
    output_directory: str
    overlays: _containers.RepeatedCompositeFieldContainer[SourceOverlay]
    environment_digest: str
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ..., project_root: _Optional[str] = ..., template_id: _Optional[str] = ..., template_version: _Optional[str] = ..., inputs_json: _Optional[bytes] = ..., output_directory: _Optional[str] = ..., overlays: _Optional[_Iterable[_Union[SourceOverlay, _Mapping]]] = ..., environment_digest: _Optional[str] = ...) -> None: ...

class CancelEvaluation(_message.Message):
    __slots__ = ("session_id", "generation")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ...) -> None: ...

class Shutdown(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class SweepCoordinate(_message.Message):
    __slots__ = ("parameter_path", "value")
    PARAMETER_PATH_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    parameter_path: str
    value: float
    def __init__(self, parameter_path: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...

class EvaluateSweepPoint(_message.Message):
    __slots__ = ("session_id", "sweep_id", "point_index", "coordinates", "project_root", "template_id", "template_version", "baseline_inputs_json", "output_directory", "overlays", "environment_digest")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SWEEP_ID_FIELD_NUMBER: _ClassVar[int]
    POINT_INDEX_FIELD_NUMBER: _ClassVar[int]
    COORDINATES_FIELD_NUMBER: _ClassVar[int]
    PROJECT_ROOT_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_ID_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_VERSION_FIELD_NUMBER: _ClassVar[int]
    BASELINE_INPUTS_JSON_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    OVERLAYS_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENT_DIGEST_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    sweep_id: int
    point_index: int
    coordinates: _containers.RepeatedCompositeFieldContainer[SweepCoordinate]
    project_root: str
    template_id: str
    template_version: str
    baseline_inputs_json: bytes
    output_directory: str
    overlays: _containers.RepeatedCompositeFieldContainer[SourceOverlay]
    environment_digest: str
    def __init__(self, session_id: _Optional[str] = ..., sweep_id: _Optional[int] = ..., point_index: _Optional[int] = ..., coordinates: _Optional[_Iterable[_Union[SweepCoordinate, _Mapping]]] = ..., project_root: _Optional[str] = ..., template_id: _Optional[str] = ..., template_version: _Optional[str] = ..., baseline_inputs_json: _Optional[bytes] = ..., output_directory: _Optional[str] = ..., overlays: _Optional[_Iterable[_Union[SourceOverlay, _Mapping]]] = ..., environment_digest: _Optional[str] = ...) -> None: ...

class CancelSweep(_message.Message):
    __slots__ = ("session_id", "sweep_id")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SWEEP_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    sweep_id: int
    def __init__(self, session_id: _Optional[str] = ..., sweep_id: _Optional[int] = ...) -> None: ...

class RunExportJob(_message.Message):
    __slots__ = ("session_id", "job_id", "project_root", "template_id", "template_version", "inputs_json", "overlays", "environment_digest", "kind", "output_directory", "options_json", "basename")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    PROJECT_ROOT_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_ID_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_VERSION_FIELD_NUMBER: _ClassVar[int]
    INPUTS_JSON_FIELD_NUMBER: _ClassVar[int]
    OVERLAYS_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENT_DIGEST_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_JSON_FIELD_NUMBER: _ClassVar[int]
    BASENAME_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    job_id: int
    project_root: str
    template_id: str
    template_version: str
    inputs_json: bytes
    overlays: _containers.RepeatedCompositeFieldContainer[SourceOverlay]
    environment_digest: str
    kind: str
    output_directory: str
    options_json: bytes
    basename: str
    def __init__(self, session_id: _Optional[str] = ..., job_id: _Optional[int] = ..., project_root: _Optional[str] = ..., template_id: _Optional[str] = ..., template_version: _Optional[str] = ..., inputs_json: _Optional[bytes] = ..., overlays: _Optional[_Iterable[_Union[SourceOverlay, _Mapping]]] = ..., environment_digest: _Optional[str] = ..., kind: _Optional[str] = ..., output_directory: _Optional[str] = ..., options_json: _Optional[bytes] = ..., basename: _Optional[str] = ...) -> None: ...

class CancelExportJob(_message.Message):
    __slots__ = ("session_id", "job_id")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    job_id: int
    def __init__(self, session_id: _Optional[str] = ..., job_id: _Optional[int] = ...) -> None: ...

class WorkerRequest(_message.Message):
    __slots__ = ("hello", "evaluate", "cancel", "shutdown", "evaluate_sweep_point", "cancel_sweep", "run_export_job", "cancel_export_job")
    HELLO_FIELD_NUMBER: _ClassVar[int]
    EVALUATE_FIELD_NUMBER: _ClassVar[int]
    CANCEL_FIELD_NUMBER: _ClassVar[int]
    SHUTDOWN_FIELD_NUMBER: _ClassVar[int]
    EVALUATE_SWEEP_POINT_FIELD_NUMBER: _ClassVar[int]
    CANCEL_SWEEP_FIELD_NUMBER: _ClassVar[int]
    RUN_EXPORT_JOB_FIELD_NUMBER: _ClassVar[int]
    CANCEL_EXPORT_JOB_FIELD_NUMBER: _ClassVar[int]
    hello: Hello
    evaluate: EvaluateProject
    cancel: CancelEvaluation
    shutdown: Shutdown
    evaluate_sweep_point: EvaluateSweepPoint
    cancel_sweep: CancelSweep
    run_export_job: RunExportJob
    cancel_export_job: CancelExportJob
    def __init__(self, hello: _Optional[_Union[Hello, _Mapping]] = ..., evaluate: _Optional[_Union[EvaluateProject, _Mapping]] = ..., cancel: _Optional[_Union[CancelEvaluation, _Mapping]] = ..., shutdown: _Optional[_Union[Shutdown, _Mapping]] = ..., evaluate_sweep_point: _Optional[_Union[EvaluateSweepPoint, _Mapping]] = ..., cancel_sweep: _Optional[_Union[CancelSweep, _Mapping]] = ..., run_export_job: _Optional[_Union[RunExportJob, _Mapping]] = ..., cancel_export_job: _Optional[_Union[CancelExportJob, _Mapping]] = ...) -> None: ...

class CapabilityReport(_message.Message):
    __slots__ = ("protocol_version", "capabilities", "python_version", "interpreter", "machinewright_version", "cad_backend_version", "transports")
    PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    PYTHON_VERSION_FIELD_NUMBER: _ClassVar[int]
    INTERPRETER_FIELD_NUMBER: _ClassVar[int]
    MACHINEWRIGHT_VERSION_FIELD_NUMBER: _ClassVar[int]
    CAD_BACKEND_VERSION_FIELD_NUMBER: _ClassVar[int]
    TRANSPORTS_FIELD_NUMBER: _ClassVar[int]
    protocol_version: int
    capabilities: _containers.RepeatedScalarFieldContainer[str]
    python_version: str
    interpreter: str
    machinewright_version: str
    cad_backend_version: str
    transports: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, protocol_version: _Optional[int] = ..., capabilities: _Optional[_Iterable[str]] = ..., python_version: _Optional[str] = ..., interpreter: _Optional[str] = ..., machinewright_version: _Optional[str] = ..., cad_backend_version: _Optional[str] = ..., transports: _Optional[_Iterable[str]] = ...) -> None: ...

class EvaluationProgress(_message.Message):
    __slots__ = ("session_id", "generation", "stage", "completed", "total", "message")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    STAGE_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    stage: str
    completed: int
    total: int
    message: str
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ..., stage: _Optional[str] = ..., completed: _Optional[int] = ..., total: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class PartialDiagnostics(_message.Message):
    __slots__ = ("session_id", "generation", "diagnostics_json")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    DIAGNOSTICS_JSON_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    diagnostics_json: bytes
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ..., diagnostics_json: _Optional[bytes] = ...) -> None: ...

class SourceDigest(_message.Message):
    __slots__ = ("relative_path", "digest")
    RELATIVE_PATH_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    relative_path: str
    digest: str
    def __init__(self, relative_path: _Optional[str] = ..., digest: _Optional[str] = ...) -> None: ...

class EvaluationCompleted(_message.Message):
    __slots__ = ("session_id", "generation", "snapshot_path", "graph_digest", "artifact_manifest_digest", "evaluated_sources")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    SNAPSHOT_PATH_FIELD_NUMBER: _ClassVar[int]
    GRAPH_DIGEST_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_MANIFEST_DIGEST_FIELD_NUMBER: _ClassVar[int]
    EVALUATED_SOURCES_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    snapshot_path: str
    graph_digest: str
    artifact_manifest_digest: str
    evaluated_sources: _containers.RepeatedCompositeFieldContainer[SourceDigest]
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ..., snapshot_path: _Optional[str] = ..., graph_digest: _Optional[str] = ..., artifact_manifest_digest: _Optional[str] = ..., evaluated_sources: _Optional[_Iterable[_Union[SourceDigest, _Mapping]]] = ...) -> None: ...

class EvaluationFailed(_message.Message):
    __slots__ = ("session_id", "generation", "code", "message", "traceback", "diagnostics_json")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    TRACEBACK_FIELD_NUMBER: _ClassVar[int]
    DIAGNOSTICS_JSON_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    code: str
    message: str
    traceback: str
    diagnostics_json: bytes
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ..., code: _Optional[str] = ..., message: _Optional[str] = ..., traceback: _Optional[str] = ..., diagnostics_json: _Optional[bytes] = ...) -> None: ...

class EvaluationCancelled(_message.Message):
    __slots__ = ("session_id", "generation")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ...) -> None: ...

class SweepPointCompleted(_message.Message):
    __slots__ = ("session_id", "sweep_id", "point_index", "snapshot_path", "graph_digest", "artifact_manifest_digest")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SWEEP_ID_FIELD_NUMBER: _ClassVar[int]
    POINT_INDEX_FIELD_NUMBER: _ClassVar[int]
    SNAPSHOT_PATH_FIELD_NUMBER: _ClassVar[int]
    GRAPH_DIGEST_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_MANIFEST_DIGEST_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    sweep_id: int
    point_index: int
    snapshot_path: str
    graph_digest: str
    artifact_manifest_digest: str
    def __init__(self, session_id: _Optional[str] = ..., sweep_id: _Optional[int] = ..., point_index: _Optional[int] = ..., snapshot_path: _Optional[str] = ..., graph_digest: _Optional[str] = ..., artifact_manifest_digest: _Optional[str] = ...) -> None: ...

class SweepPointFailed(_message.Message):
    __slots__ = ("session_id", "sweep_id", "point_index", "code", "message")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SWEEP_ID_FIELD_NUMBER: _ClassVar[int]
    POINT_INDEX_FIELD_NUMBER: _ClassVar[int]
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    sweep_id: int
    point_index: int
    code: str
    message: str
    def __init__(self, session_id: _Optional[str] = ..., sweep_id: _Optional[int] = ..., point_index: _Optional[int] = ..., code: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class SweepPointCancelled(_message.Message):
    __slots__ = ("session_id", "sweep_id", "point_index")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SWEEP_ID_FIELD_NUMBER: _ClassVar[int]
    POINT_INDEX_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    sweep_id: int
    point_index: int
    def __init__(self, session_id: _Optional[str] = ..., sweep_id: _Optional[int] = ..., point_index: _Optional[int] = ...) -> None: ...

class EvaluationInputSchema(_message.Message):
    __slots__ = ("session_id", "generation", "schema_json")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    SCHEMA_JSON_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    generation: int
    schema_json: bytes
    def __init__(self, session_id: _Optional[str] = ..., generation: _Optional[int] = ..., schema_json: _Optional[bytes] = ...) -> None: ...

class ExportJobProgress(_message.Message):
    __slots__ = ("session_id", "job_id", "stage", "completed", "total", "message")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    STAGE_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    job_id: int
    stage: str
    completed: int
    total: int
    message: str
    def __init__(self, session_id: _Optional[str] = ..., job_id: _Optional[int] = ..., stage: _Optional[str] = ..., completed: _Optional[int] = ..., total: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class ExportJobCompleted(_message.Message):
    __slots__ = ("session_id", "job_id", "output_directory", "result_json")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    job_id: int
    output_directory: str
    result_json: bytes
    def __init__(self, session_id: _Optional[str] = ..., job_id: _Optional[int] = ..., output_directory: _Optional[str] = ..., result_json: _Optional[bytes] = ...) -> None: ...

class ExportJobFailed(_message.Message):
    __slots__ = ("session_id", "job_id", "code", "message", "traceback")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    TRACEBACK_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    job_id: int
    code: str
    message: str
    traceback: str
    def __init__(self, session_id: _Optional[str] = ..., job_id: _Optional[int] = ..., code: _Optional[str] = ..., message: _Optional[str] = ..., traceback: _Optional[str] = ...) -> None: ...

class ExportJobCancelled(_message.Message):
    __slots__ = ("session_id", "job_id")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    job_id: int
    def __init__(self, session_id: _Optional[str] = ..., job_id: _Optional[int] = ...) -> None: ...

class WorkerEvent(_message.Message):
    __slots__ = ("capabilities", "progress", "diagnostics", "completed", "failed", "cancelled", "sweep_point_completed", "sweep_point_failed", "sweep_point_cancelled", "input_schema", "export_progress", "export_completed", "export_failed", "export_cancelled")
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    DIAGNOSTICS_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    CANCELLED_FIELD_NUMBER: _ClassVar[int]
    SWEEP_POINT_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    SWEEP_POINT_FAILED_FIELD_NUMBER: _ClassVar[int]
    SWEEP_POINT_CANCELLED_FIELD_NUMBER: _ClassVar[int]
    INPUT_SCHEMA_FIELD_NUMBER: _ClassVar[int]
    EXPORT_PROGRESS_FIELD_NUMBER: _ClassVar[int]
    EXPORT_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    EXPORT_FAILED_FIELD_NUMBER: _ClassVar[int]
    EXPORT_CANCELLED_FIELD_NUMBER: _ClassVar[int]
    capabilities: CapabilityReport
    progress: EvaluationProgress
    diagnostics: PartialDiagnostics
    completed: EvaluationCompleted
    failed: EvaluationFailed
    cancelled: EvaluationCancelled
    sweep_point_completed: SweepPointCompleted
    sweep_point_failed: SweepPointFailed
    sweep_point_cancelled: SweepPointCancelled
    input_schema: EvaluationInputSchema
    export_progress: ExportJobProgress
    export_completed: ExportJobCompleted
    export_failed: ExportJobFailed
    export_cancelled: ExportJobCancelled
    def __init__(self, capabilities: _Optional[_Union[CapabilityReport, _Mapping]] = ..., progress: _Optional[_Union[EvaluationProgress, _Mapping]] = ..., diagnostics: _Optional[_Union[PartialDiagnostics, _Mapping]] = ..., completed: _Optional[_Union[EvaluationCompleted, _Mapping]] = ..., failed: _Optional[_Union[EvaluationFailed, _Mapping]] = ..., cancelled: _Optional[_Union[EvaluationCancelled, _Mapping]] = ..., sweep_point_completed: _Optional[_Union[SweepPointCompleted, _Mapping]] = ..., sweep_point_failed: _Optional[_Union[SweepPointFailed, _Mapping]] = ..., sweep_point_cancelled: _Optional[_Union[SweepPointCancelled, _Mapping]] = ..., input_schema: _Optional[_Union[EvaluationInputSchema, _Mapping]] = ..., export_progress: _Optional[_Union[ExportJobProgress, _Mapping]] = ..., export_completed: _Optional[_Union[ExportJobCompleted, _Mapping]] = ..., export_failed: _Optional[_Union[ExportJobFailed, _Mapping]] = ..., export_cancelled: _Optional[_Union[ExportJobCancelled, _Mapping]] = ...) -> None: ...
