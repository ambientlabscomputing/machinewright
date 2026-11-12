/**
 * DOM overlay for the viewport WebView: an Assembled/Exploded view
 * switcher and a parts list with per-part and per-material-class
 * visibility toggles. Lives inside the WebView (like the scene itself) so
 * toggling never round-trips through React; all colors come from the
 * generated design-token theme.
 */
import { MATERIAL_CLASS_LABEL, type MaterialClass } from "./materials";

export type ViewMode = "assembled" | "exploded";

export interface PanelPart {
  readonly id: string;
  readonly label: string;
  readonly materialClass: MaterialClass;
}

export interface PanelCallbacks {
  readonly onModeChange: (mode: ViewMode) => void;
  readonly onVisibilityChange: (ids: readonly string[], visible: boolean) => void;
  readonly onToggleMaximize: () => void;
  /** Per-axis explode distance multiplier, from the sliders shown in exploded mode. */
  readonly onExplodeScaleChange: (axis: "x" | "y" | "z", value: number) => void;
}

export const EXPLODE_SCALE_DEFAULT = 1.5;
export const EXPLODE_SCALE_MAX = 4;

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONS = {
  // Three layers stacked flush vs. spread apart.
  assembled: `${SVG_OPEN}<rect x="5" y="6" width="14" height="3.5" rx="1"/><rect x="5" y="10.25" width="14" height="3.5" rx="1"/><rect x="5" y="14.5" width="14" height="3.5" rx="1"/></svg>`,
  exploded: `${SVG_OPEN}<rect x="5" y="2.5" width="14" height="3.5" rx="1"/><rect x="5" y="10.25" width="14" height="3.5" rx="1"/><rect x="5" y="18" width="14" height="3.5" rx="1"/></svg>`,
  maximize: `${SVG_OPEN}<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  restore: `${SVG_OPEN}<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`,
};

type Theme = Record<string, string>;

const CLASS_ORDER: readonly MaterialClass[] = ["printed", "machined", "purchased", "sheet", "other"];

export interface ViewportPanel {
  setParts(parts: readonly PanelPart[], hidden: ReadonlySet<string>): void;
  setHidden(hidden: ReadonlySet<string>): void;
  setMaximized(maximized: boolean): void;
}

export function createViewportPanel(theme: Theme, callbacks: PanelCallbacks): ViewportPanel {
  const style = document.createElement("style");
  style.textContent = `
    .mw-panel { position: absolute; top: 8px; left: 8px; bottom: 8px; width: 220px; pointer-events: none;
      display: flex; flex-direction: column; gap: 6px; font: 12px -apple-system, system-ui, sans-serif;
      color: ${theme["color-text-primary"]}; user-select: none; }
    .mw-card { pointer-events: auto; flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; background: ${theme["color-surface-panel"]}; border: 1px solid ${theme["color-border-subtle"]};
      border-radius: 6px; overflow: hidden; }
    .mw-seg { flex: none; flex-direction: row; display: flex; padding: 3px; gap: 3px; }
    .mw-top { pointer-events: none; display: flex; gap: 6px; }
    .mw-top .mw-seg { flex: 1; }
    .mw-top > .mw-card.mw-single { padding: 3px; }
    .mw-top button, .mw-seg button { display: flex; align-items: center; justify-content: center; }
    .mw-single button { border: 0; border-radius: 4px; padding: 5px 8px; cursor: pointer; background: transparent;
      color: ${theme["color-text-secondary"]}; }
    .mw-single button:hover { background: ${theme["color-surface-control"]}; color: ${theme["color-text-primary"]}; }
    .mw-seg button { flex: 1; border: 0; border-radius: 4px; padding: 5px 0; cursor: pointer; font: inherit;
      color: ${theme["color-text-secondary"]}; background: transparent; }
    .mw-seg button[aria-pressed="true"] { background: ${theme["color-surface-control"]}; color: ${theme["color-text-primary"]}; }
    .mw-head { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; cursor: pointer;
      color: ${theme["color-text-secondary"]}; }
    .mw-head button { border: 0; background: transparent; color: ${theme["color-text-secondary"]}; cursor: pointer; font: inherit; }
    .mw-explode { padding: 6px 8px; gap: 4px; }
    .mw-slider { display: flex; align-items: center; gap: 8px; }
    .mw-slider span { width: 10px; font-weight: 600; }
    .mw-slider input { flex: 1; min-width: 0; margin: 0; }
    .mw-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; border-top: 1px solid ${theme["color-border-subtle"]}; padding: 4px 0; }
    .mw-row { display: flex; align-items: center; gap: 6px; padding: 2px 8px; cursor: pointer; }
    .mw-row:hover { background: ${theme["color-surface-control"]}; }
    .mw-row.mw-group { color: ${theme["color-text-secondary"]}; padding-top: 6px; }
    .mw-row.mw-off .mw-name { color: ${theme["color-status-stale"]}; text-decoration: line-through; }
    .mw-row.mw-part { padding-left: 22px; }
    .mw-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mw-swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
    .mw-row input { margin: 0; pointer-events: none; accent-color: ${theme["color-accent-selection"]}; }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "mw-panel";

  const seg = document.createElement("div");
  seg.className = "mw-card mw-seg";
  const modeButtons = new Map<ViewMode, HTMLButtonElement>();
  for (const [mode, label] of [["assembled", "Assembled view"], ["exploded", "Exploded view"]] as const) {
    const button = document.createElement("button");
    button.innerHTML = ICONS[mode];
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(mode === "assembled"));
    button.addEventListener("click", () => {
      for (const [m, b] of modeButtons) b.setAttribute("aria-pressed", String(m === mode));
      explodeCard.style.display = mode === "exploded" ? "" : "none";
      callbacks.onModeChange(mode);
    });
    modeButtons.set(mode, button);
    seg.appendChild(button);
  }

  const maximizeCard = document.createElement("div");
  maximizeCard.className = "mw-card mw-single";
  const maximizeButton = document.createElement("button");
  maximizeButton.addEventListener("click", () => callbacks.onToggleMaximize());
  maximizeCard.appendChild(maximizeButton);
  function showMaximized(maximized: boolean): void {
    maximizeButton.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    const label = maximized ? "Restore panels" : "Maximize viewport";
    maximizeButton.title = label;
    maximizeButton.setAttribute("aria-label", label);
    maximizeButton.setAttribute("aria-pressed", String(maximized));
  }
  showMaximized(false);

  const top = document.createElement("div");
  top.className = "mw-top";
  top.append(seg, maximizeCard);
  root.appendChild(top);

  // Axis sliders, only relevant (and shown) while the exploded view is active.
  // Axis colors match the scene's axes helper.
  const explodeCard = document.createElement("div");
  explodeCard.className = "mw-card mw-explode";
  explodeCard.style.display = "none";
  for (const [axis, colorToken] of [
    ["x", "color-accent-action"],
    ["y", "color-status-success"],
    ["z", "color-accent-selection"],
  ] as const) {
    const row = document.createElement("label");
    row.className = "mw-slider";
    row.title = `Explode distance along ${axis.toUpperCase()}`;
    const name = document.createElement("span");
    name.textContent = axis.toUpperCase();
    name.style.color = theme[colorToken];
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(EXPLODE_SCALE_MAX);
    slider.step = "0.05";
    slider.value = String(EXPLODE_SCALE_DEFAULT);
    slider.style.accentColor = theme[colorToken];
    slider.addEventListener("input", () => callbacks.onExplodeScaleChange(axis, Number(slider.value)));
    row.append(name, slider);
    explodeCard.appendChild(row);
  }
  root.appendChild(explodeCard);

  const card = document.createElement("div");
  card.className = "mw-card";
  const head = document.createElement("div");
  head.className = "mw-head";
  const title = document.createElement("span");
  const bulk = document.createElement("button");
  head.append(title, bulk);
  const list = document.createElement("div");
  list.className = "mw-list";
  card.append(head, list);
  root.appendChild(card);
  document.body.appendChild(root);

  let parts: readonly PanelPart[] = [];
  let hidden: ReadonlySet<string> = new Set();
  let collapsed = false;
  const checkboxes = new Map<string, { row: HTMLElement; box: HTMLInputElement }>();
  const groupBoxes = new Map<MaterialClass, HTMLInputElement>();

  title.textContent = "Parts";
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    list.style.display = collapsed ? "none" : "";
  });
  bulk.addEventListener("click", (event) => {
    event.stopPropagation();
    const anyHidden = hidden.size > 0;
    callbacks.onVisibilityChange(parts.map((p) => p.id), anyHidden);
  });

  function refresh(): void {
    title.textContent = `Parts (${parts.length - hidden.size}/${parts.length})`;
    bulk.textContent = hidden.size > 0 ? "Show all" : "Hide all";
    for (const [id, { row, box }] of checkboxes) {
      const visible = !hidden.has(id);
      box.checked = visible;
      row.classList.toggle("mw-off", !visible);
    }
    for (const [cls, box] of groupBoxes) {
      const members = parts.filter((p) => p.materialClass === cls);
      const shown = members.filter((p) => !hidden.has(p.id)).length;
      box.checked = shown === members.length;
      box.indeterminate = shown > 0 && shown < members.length;
    }
  }

  function rebuild(): void {
    list.replaceChildren();
    checkboxes.clear();
    groupBoxes.clear();
    for (const cls of CLASS_ORDER) {
      const members = parts.filter((p) => p.materialClass === cls).sort((a, b) => a.label.localeCompare(b.label));
      if (members.length === 0) continue;

      const group = document.createElement("div");
      group.className = "mw-row mw-group";
      const groupBox = document.createElement("input");
      groupBox.type = "checkbox";
      // The whole row is the hit target (the checkbox just mirrors state),
      // so one click fires exactly one toggle.
      group.addEventListener("click", () =>
        callbacks.onVisibilityChange(
          members.map((p) => p.id),
          members.some((p) => hidden.has(p.id)),
        ),
      );
      const swatch = document.createElement("span");
      swatch.className = "mw-swatch";
      swatch.style.background = theme[`color-material-${cls}`];
      const name = document.createElement("span");
      name.className = "mw-name";
      name.textContent = `${MATERIAL_CLASS_LABEL[cls]} (${members.length})`;
      group.append(groupBox, swatch, name);
      list.appendChild(group);
      groupBoxes.set(cls, groupBox);

      for (const part of members) {
        const row = document.createElement("div");
        row.className = "mw-row mw-part";
        row.title = part.id;
        const box = document.createElement("input");
        box.type = "checkbox";
        row.addEventListener("click", () => callbacks.onVisibilityChange([part.id], hidden.has(part.id)));
        const label = document.createElement("span");
        label.className = "mw-name";
        label.textContent = part.label;
        row.append(box, label);
        list.appendChild(row);
        checkboxes.set(part.id, { row, box });
      }
    }
    refresh();
  }

  return {
    setParts(nextParts, nextHidden) {
      parts = nextParts;
      hidden = nextHidden;
      rebuild();
    },
    setHidden(nextHidden) {
      hidden = nextHidden;
      refresh();
    },
    setMaximized: showMaximized,
  };
}
