/**
 * Maps a part's material name (graph `material_name`, from
 * `machinewright.lib.materials`) to a material class whose color lives in
 * the design tokens (`colors.material`, projected into
 * viewport-theme.json as `color-material-<class>`).
 *
 * The class set is deliberately small so the viewport legend stays
 * readable and every color comes from the approved palette; unknown
 * materials fall into `other` rather than inventing a new color.
 */
export type MaterialClass = "printed" | "machined" | "purchased" | "sheet" | "other";

const PRINTED = /\b(pla|petg|abs|asa|tpu|nylon|pa12|pa-cf|resin)\b|petg-cf|printed/i;
const MACHINED = /alumin|6061|7075|steel|brass|titanium|machined/i;
const PURCHASED = /off-the-shelf|purchased|\bcots\b/i;
const SHEET = /sheet|plate|acrylic|plywood|\bmdf\b|copper/i;

const PROCESS_CLASS: Record<string, MaterialClass> = {
  PRINTED: "printed",
  MACHINED: "machined",
  PURCHASED: "purchased",
  SHEET: "sheet",
  OTHER: "other",
};

/**
 * Classifies by the material's declared `Process` when the graph provides
 * it (authoritative), else falls back to guessing from the material name
 * (older snapshots, third-party graphs).
 */
export function materialClass(
  materialName: string | null | undefined,
  materialProcess?: string | null,
): MaterialClass {
  const byProcess = materialProcess ? PROCESS_CLASS[materialProcess] : undefined;
  if (byProcess) return byProcess;
  if (!materialName) return "other";
  if (PURCHASED.test(materialName)) return "purchased";
  if (PRINTED.test(materialName)) return "printed";
  if (MACHINED.test(materialName)) return "machined";
  if (SHEET.test(materialName)) return "sheet";
  return "other";
}

export const MATERIAL_CLASS_LABEL: Record<MaterialClass, string> = {
  printed: "Printed",
  machined: "Machined",
  purchased: "Purchased",
  sheet: "Sheet",
  other: "Other",
};
