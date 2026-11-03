import type { Diagram, DiagramElement, VisualItem, VisualStep } from "./visualTypes";

export const DIAGRAM_LIMITS = { dimension: 4096, elements: 80, text: 240 } as const;
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= DIAGRAM_LIMITS.dimension;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= DIAGRAM_LIMITS.text;
function pointFields(obj: Record<string, unknown>, ...fields: string[]) { return fields.every((key) => finite(obj[key])); }
function onlyKeys(obj: Record<string, unknown>, allowed: string[]) { return Object.keys(obj).every((key) => allowed.includes(key)); }

/** Validate and copy declarative drawing data. No markup, URLs, styles, or unknown fields are interpreted. */
export function validateDiagram(input: unknown): Diagram | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!onlyKeys(raw, ["width", "height", "elements"]) || !finite(raw.width) || raw.width < 1 || !finite(raw.height) || raw.height < 1 || !Array.isArray(raw.elements) || raw.elements.length > DIAGRAM_LIMITS.elements) return null;
  const ids = new Set<string>();
  const elements: DiagramElement[] = [];
  for (const candidate of raw.elements) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[\w-]{1,64}$/.test(item.id) || ids.has(item.id) || typeof item.type !== "string") return null;
    ids.add(item.id);
    if (has(item, "changed") && typeof item.changed !== "boolean") return null;
    if (item.type === "box" || item.type === "cell") {
      if (!onlyKeys(item, ["id", "type", "x", "y", "width", "height", "text", "changed", "oldText"]) || !pointFields(item, "x", "y", "width", "height") || (item.width as number) < 1 || (item.height as number) < 1 || (has(item, "text") && !text(item.text)) || (has(item, "oldText") && !text(item.oldText))) return null;
      elements.push({ id: item.id, type: item.type, x: item.x as number, y: item.y as number, width: item.width as number, height: item.height as number, ...(typeof item.text === "string" ? { text: item.text } : {}), ...(typeof item.oldText === "string" ? { oldText: item.oldText } : {}), ...(item.changed ? { changed: true } : {}) });
    } else if (item.type === "text") {
      if (!onlyKeys(item, ["id", "type", "x", "y", "text", "changed"]) || !pointFields(item, "x", "y") || !text(item.text)) return null;
      elements.push({ id: item.id, type: "text", x: item.x as number, y: item.y as number, text: item.text, ...(item.changed ? { changed: true } : {}) });
    } else if (item.type === "arrow" || item.type === "line") {
      if (!onlyKeys(item, ["id", "type", "x1", "y1", "x2", "y2", "label", "dashed", "changed"]) || !pointFields(item, "x1", "y1", "x2", "y2") || (has(item, "label") && !text(item.label)) || (has(item, "dashed") && typeof item.dashed !== "boolean")) return null;
      elements.push({ id: item.id, type: item.type, x1: item.x1 as number, y1: item.y1 as number, x2: item.x2 as number, y2: item.y2 as number, ...(typeof item.label === "string" ? { label: item.label } : {}), ...(item.dashed ? { dashed: true } : {}), ...(item.changed ? { changed: true } : {}) });
    } else if (item.type === "point") {
      if (!onlyKeys(item, ["id", "type", "x", "y", "label", "changed"]) || !pointFields(item, "x", "y") || (has(item, "label") && !text(item.label))) return null;
      elements.push({ id: item.id, type: "point", x: item.x as number, y: item.y as number, ...(typeof item.label === "string" ? { label: item.label } : {}), ...(item.changed ? { changed: true } : {}) });
    } else return null;
  }
  return { width: raw.width as number, height: raw.height as number, elements };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum;

/** Validate API supplied visual metadata before it reaches cards and action callbacks. */
export function validateVisualItem(input: unknown): VisualItem | null {
  if (!isRecord(input) || !onlyKeys(input, ["id", "number", "title", "kind", "provenance", "source", "image_url", "body", "explanation", "diagram", "steps"])) return null;
  if (typeof input.id !== "string" || !/^[\w-]{1,80}$/.test(input.id) || !Number.isSafeInteger(input.number) || (input.number as number) < 1 || !boundedText(input.title, 180)) return null;
  if (!["example", "figure", "process"].includes(String(input.kind)) || !["source", "redraw", "invented"].includes(String(input.provenance))) return null;
  const source = input.source;
  if (source !== undefined) {
    if (!isRecord(source) || !onlyKeys(source, ["material_id", "material_name", "page", "quote", "matched", "uncertain", "crop"]) || typeof source.material_id !== "string" || !/^[\w-]{1,128}$/.test(source.material_id) || !boundedText(source.material_name, 200) || !Number.isSafeInteger(source.page) || (source.page as number) < 1 || typeof source.matched !== "boolean" || (source.uncertain !== undefined && typeof source.uncertain !== "boolean") || (source.quote !== undefined && !boundedText(source.quote, 2000))) return null;
    if (source.crop !== undefined && (!isRecord(source.crop) || !onlyKeys(source.crop, ["x", "y", "width", "height"]) || !pointFields(source.crop, "x", "y", "width", "height") || (source.crop.width as number) < 1 || (source.crop.height as number) < 1)) return null;
  }
  if (input.provenance !== "invented" && source === undefined) return null;
  if (input.provenance === 'invented' && source !== undefined) return null;
  if ((input.image_url !== undefined && !boundedText(input.image_url, 500)) || (input.body !== undefined && !boundedText(input.body, 4000)) || (input.explanation !== undefined && !boundedText(input.explanation, 2000))) return null;
  const diagram = input.diagram === undefined ? undefined : validateDiagram(input.diagram);
  if (input.diagram !== undefined && !diagram) return null;
  let steps: VisualStep[] | undefined;
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length > 40) return null;
    steps = [];
    for (const candidate of input.steps) {
      if (!isRecord(candidate) || !onlyKeys(candidate, ["title", "changes", "reason", "diagram", "page", "quote", "matched", "uncertain"]) || !boundedText(candidate.title, 180) || !Array.isArray(candidate.changes) || candidate.changes.length > 20 || !candidate.changes.every((change) => boundedText(change, 500)) || (candidate.reason !== undefined && !boundedText(candidate.reason, 1000)) || (candidate.page !== undefined && (!Number.isSafeInteger(candidate.page) || (candidate.page as number) < 1)) || (candidate.quote !== undefined && !boundedText(candidate.quote, 2000)) || (candidate.matched !== undefined && typeof candidate.matched !== "boolean") || (candidate.uncertain !== undefined && typeof candidate.uncertain !== "boolean")) return null;
      if (input.kind === "process" && input.provenance === "source" && candidate.page === undefined) return null;
      const stepDiagram = candidate.diagram === undefined ? undefined : validateDiagram(candidate.diagram);
      if (candidate.diagram !== undefined && !stepDiagram) return null;
      const sourcePageStep = input.kind === "process" && input.provenance === "source" && typeof candidate.page === "number";
      if (!stepDiagram && !sourcePageStep) return null;
      steps.push({ title: candidate.title as string, changes: candidate.changes as string[], ...(stepDiagram ? { diagram: stepDiagram } : {}), ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}), ...(typeof candidate.page === "number" ? { page: candidate.page } : {}), ...(typeof candidate.quote === "string" ? { quote: candidate.quote } : {}), ...(typeof candidate.matched === "boolean" ? { matched: candidate.matched } : {}), ...(typeof candidate.uncertain === "boolean" ? { uncertain: candidate.uncertain } : {}) });
    }
  }
  return { id: input.id, number: input.number as number, title: input.title as string, kind: input.kind as VisualItem["kind"], provenance: input.provenance as VisualItem["provenance"], ...(source ? { source: source as unknown as VisualItem["source"] } : {}), ...(typeof input.image_url === "string" ? { image_url: input.image_url } : {}), ...(typeof input.body === "string" ? { body: input.body } : {}), ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}), ...(diagram ? { diagram } : {}), ...(steps ? { steps } : {}) };
}

/** Accept only the app's exact material page image route, never a general same-origin API URL. */
export function isMaterialPageImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  return /^\/api\/courses\/[\w-]{1,128}\/materials\/[\w-]{1,128}\/pages\/[1-9]\d*$/.test(value);
}

export function materialPageImageUrl(courseId: string, materialId: string, page: number): string | undefined {
  if (!/^[\w-]{1,128}$/.test(courseId) || !/^[\w-]{1,128}$/.test(materialId) || !Number.isSafeInteger(page) || page < 1) return undefined;
  return `/api/courses/${courseId}/materials/${materialId}/pages/${page}`;
}

export function materialPageImageAt(url: unknown, page: number): string | undefined {
  if (!isMaterialPageImageUrl(url) || !Number.isSafeInteger(page) || page < 1) return undefined;
  return url.replace(/\/[1-9]\d*$/, `/${page}`);
}

export function validateVisualForCourse(input: unknown, courseId: string, materials: { id: string; name: string; pages: { number: number }[] }[]): VisualItem | null {
  const visual = validateVisualItem(input);
  if (!visual || !visual.source) return visual;
  const material = materials.find((entry) => entry.id === visual.source!.material_id);
  if (!material || !material.pages.some((page) => page.number === visual.source!.page)) return null;
  if (visual.steps?.some((step) => step.page !== undefined && !material.pages.some((page) => page.number === step.page))) return null;
  const image_url = materialPageImageUrl(courseId, material.id, visual.source.page);
  if (!image_url) return null;
  return { ...visual, source: { ...visual.source, material_name: material.name }, image_url };
}
