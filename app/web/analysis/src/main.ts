/**
 * Bundled behavior-lab chart surface (RFD-19 M3, "Behavior laboratory").
 * Renders a completed sweep's points as a 1D line/scatter (one axis) or a
 * 2D feasibility grid (two axes) and reports clicks back to the host as
 * `pointSelected`, so the application shell can load that point's cached
 * graph/geometry snapshot — this surface itself never touches evaluation,
 * worker, or snapshot state, mirroring web/viewport's separation of
 * concerns.
 *
 * Uses the same `window.ReactNativeWebView.postMessage` /
 * `window.addEventListener("message", ...)` bridge convention as
 * web/viewport/src/main.ts and web/editor/src/main.ts.
 */
import * as d3 from "d3";
import {
  deserializeAnalysisHostCommand,
  serializeAnalysisSurfaceEvent,
  type SweepPointChartDatum,
} from "../../../src/protocol/surfaces/analysis";
import theme from "../../design-system/generated/viewport-theme.json";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(event: Parameters<typeof serializeAnalysisSurfaceEvent>[0]): void {
  window.ReactNativeWebView?.postMessage(serializeAnalysisSurfaceEvent(event));
}

const FEASIBLE_COLOR = theme["color-status-success"];
const INFEASIBLE_COLOR = theme["color-status-error"];
const UNKNOWN_COLOR = theme["color-status-stale"];
const SELECTED_STROKE = theme["color-accent-selection"];

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Picks the first observable present that carries a `feasible` flag, or else the first numeric one, as the value plotted on a 1D sweep's y axis. */
function primaryObservableId(points: readonly SweepPointChartDatum[]): string | null {
  for (const point of points) {
    const withFeasibility = point.observables.find((observable) => observable.feasible !== null);
    if (withFeasibility !== undefined) return withFeasibility.observableId;
  }
  for (const point of points) {
    const numeric = point.observables.find((observable) => numericValue(observable.value) !== null);
    if (numeric !== undefined) return numeric.observableId;
  }
  return null;
}

function colorFor(point: SweepPointChartDatum, observableId: string | null): string {
  if (observableId === null) return UNKNOWN_COLOR;
  const observable = point.observables.find((candidate) => candidate.observableId === observableId);
  if (observable === undefined || observable.feasible === null) return UNKNOWN_COLOR;
  return observable.feasible ? FEASIBLE_COLOR : INFEASIBLE_COLOR;
}

let sweepId = 0n;
let selectedPointIndex: number | null = null;
let currentPoints: SweepPointChartDatum[] = [];
let currentParameterPaths: string[] = [];

const svg = d3.select(document.body).append("svg");

function clear(): void {
  svg.selectAll("*").remove();
  currentPoints = [];
  currentParameterPaths = [];
}

function render(parameterPaths: readonly string[], points: readonly SweepPointChartDatum[]): void {
  currentPoints = [...points];
  currentParameterPaths = [...parameterPaths];
  svg.selectAll("*").remove();
  if (points.length === 0) return;

  const width = window.innerWidth || 640;
  const height = window.innerHeight || 400;
  const margin = { top: 24, right: 24, bottom: 40, left: 56 };
  const observableId = primaryObservableId(points);

  if (parameterPaths.length >= 2) {
    renderGrid(parameterPaths, points, width, height, margin, observableId);
  } else {
    renderLine(parameterPaths[0] ?? "", points, width, height, margin, observableId);
  }
}

function axisValue(point: SweepPointChartDatum, parameterPath: string): number {
  return point.coordinates.find((coordinate) => coordinate.parameterPath === parameterPath)?.value ?? 0;
}

function renderLine(
  parameterPath: string,
  points: readonly SweepPointChartDatum[],
  width: number,
  height: number,
  margin: { top: number; right: number; bottom: number; left: number },
  observableId: string | null,
): void {
  const xValues = points.map((point) => axisValue(point, parameterPath));
  const yValues = points.map((point) => {
    const observable = observableId === null ? undefined : point.observables.find((o) => o.observableId === observableId);
    return observable === undefined ? null : numericValue(observable.value);
  });

  const x = d3
    .scaleLinear()
    .domain([Math.min(...xValues), Math.max(...xValues)])
    .range([margin.left, width - margin.right]);

  const definedY = yValues.filter((value): value is number => value !== null);
  const y = d3
    .scaleLinear()
    .domain(definedY.length > 0 ? [Math.min(...definedY), Math.max(...definedY)] : [0, 1])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x));
  svg.append("g").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y));

  if (definedY.length >= 2) {
    const line = d3
      .line<number>()
      .defined((_, index) => yValues[index] !== null)
      .x((_, index) => x(xValues[index] ?? 0))
      .y((_, index) => y(yValues[index] ?? 0));
    svg
      .append("path")
      .datum(yValues.map((value) => value ?? 0))
      .attr("fill", "none")
      .attr("stroke", UNKNOWN_COLOR)
      .attr("stroke-width", 1)
      .attr("d", line);
  }

  svg
    .selectAll("circle")
    .data(points)
    .enter()
    .append("circle")
    .attr("cx", (point) => x(axisValue(point, parameterPath)))
    .attr("cy", (_point, index) => y(yValues[index] ?? 0))
    .attr("r", (point) => (point.pointIndex === selectedPointIndex ? 7 : 5))
    .attr("fill", (point) => colorFor(point, observableId))
    .attr("stroke", (point) => (point.pointIndex === selectedPointIndex ? SELECTED_STROKE : "none"))
    .attr("stroke-width", 2)
    .style("cursor", "pointer")
    .on("click", (_domEvent, point) => {
      selectedPointIndex = point.pointIndex;
      post({ kind: "pointSelected", sweepId, pointIndex: point.pointIndex });
      render([parameterPath], currentPoints);
    });
}

function renderGrid(
  parameterPaths: readonly string[],
  points: readonly SweepPointChartDatum[],
  width: number,
  height: number,
  margin: { top: number; right: number; bottom: number; left: number },
  observableId: string | null,
): void {
  const [pathX, pathY] = parameterPaths;
  if (pathX === undefined || pathY === undefined) return;
  const xValues = points.map((point) => axisValue(point, pathX));
  const yValues = points.map((point) => axisValue(point, pathY));

  const x = d3
    .scaleLinear()
    .domain([Math.min(...xValues), Math.max(...xValues)])
    .range([margin.left, width - margin.right]);
  const y = d3
    .scaleLinear()
    .domain([Math.min(...yValues), Math.max(...yValues)])
    .range([height - margin.bottom, margin.top]);

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x));
  svg.append("g").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y));

  svg
    .selectAll("circle")
    .data(points)
    .enter()
    .append("circle")
    .attr("cx", (point) => x(axisValue(point, pathX)))
    .attr("cy", (point) => y(axisValue(point, pathY)))
    .attr("r", (point) => (point.pointIndex === selectedPointIndex ? 8 : 6))
    .attr("fill", (point) => colorFor(point, observableId))
    .attr("stroke", (point) => (point.pointIndex === selectedPointIndex ? SELECTED_STROKE : "none"))
    .attr("stroke-width", 2)
    .style("cursor", "pointer")
    .on("click", (_domEvent, point) => {
      selectedPointIndex = point.pointIndex;
      post({ kind: "pointSelected", sweepId, pointIndex: point.pointIndex });
      render(parameterPaths, currentPoints);
    });
}

window.addEventListener("message", (event: MessageEvent<string>) => {
  const command = deserializeAnalysisHostCommand(event.data);
  switch (command.kind) {
    case "renderSweepResult":
      sweepId = command.sweepId;
      selectedPointIndex = null;
      render(command.parameterPaths, command.points);
      break;
    case "setSelectedPoint":
      if (command.sweepId === sweepId) {
        selectedPointIndex = command.pointIndex;
        render(currentParameterPaths, currentPoints);
      }
      break;
    case "clear":
      clear();
      break;
    default:
      break;
  }
});

post({ kind: "ready" });
