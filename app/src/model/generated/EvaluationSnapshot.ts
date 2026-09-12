/* eslint-disable */
/**
 * Generated from src/machinewright/schemas/EvaluationSnapshot-1.0.schema.json.
 * Do not edit by hand — run `npm run generate:model`.
 */

export type ArtifactManifestDigest = string;
export type Conservative = boolean;
export type DependencyId = string;
export type Kind = string;
export type SchemaVersion = "1.0";
export type SourceIds = string[];
export type TargetIds = string[];
export type Dependencies = DependencyRecord[];
export type Code = string;
export type Message = string;
export type Severity = "info" | "warning" | "error";
export type SourcePath = string;
export type Diagnostics = Diagnostic[];
export type ApplicableGraphDigest = string | null;
export type ObservableIds = string[];
export type ProcedureId = string;
export type Reason = string;
export type Revision = string;
export type SchemaVersion1 = "1.0";
export type RequirementId = string;
export type SchemaVersion2 = "1.0";
export type EvidenceRequirements = EvidenceRequirement[];
export type Generation = number;
export type EdgeId = string;
export type ConnectionKind = "mechanical" | "electrical_power" | "signal" | "thermal";
export type SchemaVersion3 = "1.0";
export type SourcePortId = string;
export type TargetPortId = string;
export type Connections = ConnectionEdge[];
export type ChildNodeId = string;
export type EdgeId1 = string;
export type Kind1 = "contains";
export type ParentNodeId = string;
export type SchemaVersion4 = "1.0";
export type Containment = ContainmentEdge[];
export type DefinitionId = string;
export type DefinitionRevision = string;
export type InstanceKey = string;
export type Kind2 = "assembly";
export type NodeId = string;
export type ParameterDigest = string;
export type SchemaVersion5 = "1.0";
/**
 * @minItems 3
 * @maxItems 3
 */
export type RotationDegreesXyz = [unknown, unknown, unknown];
export type SchemaVersion6 = "1.0";
/**
 * @minItems 3
 * @maxItems 3
 */
export type TranslationMm = [unknown, unknown, unknown];
export type DefinitionId1 = string;
export type DefinitionRevision1 = string;
export type Description = string;
export type FinishId = string;
export type SchemaVersion7 = "1.0";
export type Finishes = FinishRequirement[];
/**
 * @minItems 3
 * @maxItems 3
 */
export type CenterMm = [unknown, unknown, unknown];
/**
 * @minItems 3
 * @maxItems 3
 */
export type EnvelopeMm = [unknown, unknown, unknown];
export type MassG = number | string | null;
export type SchemaVersion8 = "1.0";
export type VolumeMm3 = number | string;
export type GeometryDigest = string;
export type Acceptance = string;
export type Characteristic = string;
export type InspectionId = string;
export type Method = string;
export type SchemaVersion9 = "1.0";
export type Inspections = InspectionRequirement[];
export type InstanceKey1 = string;
export type Kind3 = "part";
export type Manufacturer = string;
export type PartNumber = string;
export type Revision1 = string | null;
export type SchemaVersion10 = "1.0";
export type MaterialName = string | null;
export type NodeId1 = string;
export type ParameterDigest1 = string;
export type Name = string;
export type ProcessId = string;
export type SchemaVersion11 = "1.0";
export type SchemaVersion12 = "1.0";
export type Nodes = (AssemblyNode | PartNode)[];
export type InstanceKey2 = string;
export type Interface =
  | MechanicalMountInterface
  | ShaftInterface
  | ElectricalInterface
  | FeedbackInterface
  | ThermalInterface
  | ConnectorInterface;
export type Unit =
  | "mm"
  | "m"
  | "g"
  | "kg"
  | "V"
  | "A"
  | "ohm"
  | "mH"
  | "H"
  | "N*m"
  | "rpm"
  | "rad/s"
  | "kg*m^2"
  | "g*cm^2"
  | "degC"
  | "W"
  | "g/cm^3"
  | "kg/m^3"
  | "s";
export type Value = number | string;
export type SchemaVersion13 = "1.0";
export type FastenerCount = number;
export type InterfaceId = string;
export type Kind4 = "mechanical_mount";
export type Pattern = string;
export type SchemaVersion14 = "1.0";
export type Feature = "plain" | "key" | "flat" | "spline";
export type InterfaceId1 = string;
export type Kind5 = "shaft";
export type SchemaVersion15 = "1.0";
export type InterfaceId2 = string;
export type Kind6 = "electrical";
export type Phases = number;
export type SchemaVersion16 = "1.0";
export type FeedbackType = string;
export type InterfaceId3 = string;
export type Kind7 = "feedback";
export type Protocol = string | null;
export type Resolution = number | null;
export type SchemaVersion17 = "1.0";
export type InsulationClass = string | null;
export type InterfaceId4 = string;
export type Kind8 = "thermal";
export type SchemaVersion18 = "1.0";
export type Sensor = string | null;
export type Family = string;
export type InterfaceId5 = string;
export type Kind9 = "connector";
export type Positions = number;
export type SchemaVersion19 = "1.0";
export type MaxConnections = number | null;
export type NodeId2 = string;
export type PortId = string;
export type Required = boolean;
export type PortRole = "source" | "sink" | "bidirectional";
export type SchemaVersion20 = "1.0";
export type Ports = PortInstance[];
export type RootId = string;
export type SchemaVersion21 = "1.0";
export type GraphDigest = string;
export type Bounds = [unknown, unknown, unknown, unknown, unknown, unknown] | null;
export type ByteSize = number;
export type Digest = string;
export type Encoding = "mwm1" | "mwm2";
export type GraphNodeId = string;
export type Name1 = string;
export type SchemaVersion22 = "1.0";
export type TriangleCount = number;
export type VertexCount = number;
export type Meshes = MeshReference[];
export type ExtensionSchema = string | null;
export type Feasible = boolean | null;
export type ObservableKind = "scalar" | "series" | "interval" | "constraint_margin" | "candidate" | "extension";
export type Label = string;
export type ObservableId = string;
export type SchemaVersion23 = "1.0";
export type SourceIds1 = string[];
export type Unit1 = string | null;
export type Observables = Observable[];
export type AssetDigest = string;
export type EnvironmentDigest = string;
export type InputDigest = string;
export type MachinewrightVersion = string;
export type ProjectSourceDigest = string;
export type PythonVersion = string;
export type SchemaVersion24 = "1.0";
export type TemplateId = string;
export type TemplateSourceDigest = string;
export type TemplateVersion = string;
export type SchemaVersion25 = "1.0";
export type NodeIds = string[];
export type SchemaVersion26 = "1.0";
export type SourceId = string;
export type EndByte = number;
export type EndLine = number;
export type Path = string;
export type SchemaVersion27 = "1.0";
export type SourceDigest = string;
export type StartByte = number;
export type StartLine = number;
export type SourceMappings = SourceMapping[];

export interface EvaluationSnapshot {
  artifact_manifest_digest: ArtifactManifestDigest;
  control_configuration?: ControlConfiguration;
  dependencies?: Dependencies;
  diagnostics?: Diagnostics;
  evidence_requirements?: EvidenceRequirements;
  generation: Generation;
  graph: ResolvedHardwareGraph;
  graph_digest: GraphDigest;
  meshes?: Meshes;
  observables?: Observables;
  provenance: EvaluationProvenance;
  schema_version?: SchemaVersion25;
  source_mappings?: SourceMappings;
}
export interface ControlConfiguration {
  [k: string]: unknown;
}
export interface DependencyRecord {
  conservative?: Conservative;
  dependency_id: DependencyId;
  kind: Kind;
  schema_version?: SchemaVersion;
  source_ids?: SourceIds;
  target_ids?: TargetIds;
}
export interface Diagnostic {
  code: Code;
  context?: Context;
  message: Message;
  severity: Severity;
  source_path?: SourcePath;
}
export interface Context {
  [k: string]: unknown;
}
export interface EvidenceRequirement {
  applicable_graph_digest?: ApplicableGraphDigest;
  operating_envelope?: OperatingEnvelope;
  procedure: ProcedureRequirement;
  requirement_id: RequirementId;
  schema_version?: SchemaVersion2;
}
export interface OperatingEnvelope {
  [k: string]: unknown;
}
export interface ProcedureRequirement {
  observable_ids?: ObservableIds;
  procedure_id: ProcedureId;
  reason: Reason;
  revision: Revision;
  schema_version?: SchemaVersion1;
}
export interface ResolvedHardwareGraph {
  connections?: Connections;
  containment?: Containment;
  nodes: Nodes;
  ports?: Ports;
  root_id: RootId;
  schema_version?: SchemaVersion21;
}
export interface ConnectionEdge {
  edge_id: EdgeId;
  kind: ConnectionKind;
  schema_version?: SchemaVersion3;
  source_port_id: SourcePortId;
  target_port_id: TargetPortId;
}
export interface ContainmentEdge {
  child_node_id: ChildNodeId;
  edge_id: EdgeId1;
  kind?: Kind1;
  parent_node_id: ParentNodeId;
  schema_version?: SchemaVersion4;
}
export interface AssemblyNode {
  definition_id: DefinitionId;
  definition_revision: DefinitionRevision;
  instance_key: InstanceKey;
  kind?: Kind2;
  node_id: NodeId;
  parameter_digest: ParameterDigest;
  schema_version?: SchemaVersion5;
  transform: Transform;
}
export interface Transform {
  rotation_degrees_xyz?: RotationDegreesXyz;
  schema_version?: SchemaVersion6;
  translation_mm?: TranslationMm;
}
export interface PartNode {
  definition_id: DefinitionId1;
  definition_revision: DefinitionRevision1;
  finishes?: Finishes;
  geometry: GeometryProperties;
  geometry_digest: GeometryDigest;
  inspections?: Inspections;
  instance_key: InstanceKey1;
  kind?: Kind3;
  manufacturer_part?: ManufacturerPartIdentity | null;
  material_name?: MaterialName;
  node_id: NodeId1;
  parameter_digest: ParameterDigest1;
  parameters: Parameters;
  process?: ProcessSpec | null;
  schema_version?: SchemaVersion12;
  transform: Transform;
}
export interface FinishRequirement {
  description: Description;
  finish_id: FinishId;
  schema_version?: SchemaVersion7;
}
export interface GeometryProperties {
  center_mm: CenterMm;
  envelope_mm: EnvelopeMm;
  mass_g?: MassG;
  schema_version?: SchemaVersion8;
  volume_mm3: VolumeMm3;
}
export interface InspectionRequirement {
  acceptance: Acceptance;
  characteristic: Characteristic;
  inspection_id: InspectionId;
  method: Method;
  schema_version?: SchemaVersion9;
}
export interface ManufacturerPartIdentity {
  manufacturer: Manufacturer;
  part_number: PartNumber;
  revision?: Revision1;
  schema_version?: SchemaVersion10;
}
export interface Parameters {
  [k: string]: unknown;
}
export interface ProcessSpec {
  name: Name;
  parameters?: Parameters1;
  process_id: ProcessId;
  schema_version?: SchemaVersion11;
}
export interface Parameters1 {
  [k: string]: string;
}
export interface PortInstance {
  frame?: Transform | null;
  instance_key: InstanceKey2;
  interface: Interface;
  max_connections?: MaxConnections;
  node_id: NodeId2;
  port_id: PortId;
  required?: Required;
  role?: PortRole;
  schema_version?: SchemaVersion20;
}
export interface MechanicalMountInterface {
  bolt_circle_diameter?: Tolerance | null;
  fastener_count: FastenerCount;
  interface_id: InterfaceId;
  kind?: Kind4;
  pattern: Pattern;
  pilot_diameter?: Tolerance | null;
  schema_version?: SchemaVersion14;
}
export interface Tolerance {
  minus: Quantity;
  nominal: Quantity;
  plus: Quantity;
  schema_version?: SchemaVersion13;
}
export interface Quantity {
  unit: Unit;
  value: Value;
}
export interface ShaftInterface {
  diameter: Tolerance;
  feature?: Feature;
  interface_id: InterfaceId1;
  kind?: Kind5;
  length: Tolerance;
  schema_version?: SchemaVersion15;
}
export interface ElectricalInterface {
  continuous_current: Quantity;
  interface_id: InterfaceId2;
  kind?: Kind6;
  peak_current: Quantity;
  phases: Phases;
  schema_version?: SchemaVersion16;
  voltage: Quantity;
}
export interface FeedbackInterface {
  feedback_type: FeedbackType;
  interface_id: InterfaceId3;
  kind?: Kind7;
  protocol?: Protocol;
  resolution?: Resolution;
  schema_version?: SchemaVersion17;
}
export interface ThermalInterface {
  ambient_max: Quantity;
  ambient_min: Quantity;
  insulation_class?: InsulationClass;
  interface_id: InterfaceId4;
  kind?: Kind8;
  schema_version?: SchemaVersion18;
  sensor?: Sensor;
}
export interface ConnectorInterface {
  family: Family;
  interface_id: InterfaceId5;
  kind?: Kind9;
  pinout?: Pinout;
  positions: Positions;
  schema_version?: SchemaVersion19;
}
export interface Pinout {
  [k: string]: string;
}
export interface MeshReference {
  bounds?: Bounds;
  byte_size: ByteSize;
  digest: Digest;
  encoding?: Encoding;
  graph_node_id: GraphNodeId;
  name: Name1;
  schema_version?: SchemaVersion22;
  triangle_count: TriangleCount;
  vertex_count: VertexCount;
}
export interface Observable {
  extension_schema?: ExtensionSchema;
  feasible?: Feasible;
  kind: ObservableKind;
  label: Label;
  observable_id: ObservableId;
  schema_version?: SchemaVersion23;
  source_ids?: SourceIds1;
  unit?: Unit1;
  value: Value1;
}
export interface Value1 {
  [k: string]: unknown;
}
export interface EvaluationProvenance {
  asset_digest: AssetDigest;
  environment_digest: EnvironmentDigest;
  input_digest: InputDigest;
  machinewright_version: MachinewrightVersion;
  project_source_digest: ProjectSourceDigest;
  python_version: PythonVersion;
  schema_version?: SchemaVersion24;
  template_id: TemplateId;
  template_source_digest: TemplateSourceDigest;
  template_version: TemplateVersion;
}
export interface SourceMapping {
  node_ids: NodeIds;
  schema_version?: SchemaVersion26;
  source_id: SourceId;
  span: SourceSpan;
}
export interface SourceSpan {
  end_byte: EndByte;
  end_line: EndLine;
  path: Path;
  schema_version?: SchemaVersion27;
  source_digest: SourceDigest;
  start_byte: StartByte;
  start_line: StartLine;
}
