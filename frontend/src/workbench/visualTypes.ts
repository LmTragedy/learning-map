export type VisualKind = "example" | "figure" | "process";
export type VisualProvenance = "source" | "redraw" | "invented";
export type VisualSource = {
  material_id: string;
  material_name: string;
  page: number;
  quote?: string;
  /** Citation match only; this does not establish semantic correctness. */
  matched: boolean;
  uncertain?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
};

export type DiagramElement =
  | { id: string; type: "box"; x: number; y: number; width: number; height: number; text?: string; changed?: boolean; oldText?: string }
  | { id: string; type: "cell"; x: number; y: number; width: number; height: number; text?: string; changed?: boolean; oldText?: string }
  | { id: string; type: "text"; x: number; y: number; text: string; changed?: boolean }
  | { id: string; type: "arrow"; x1: number; y1: number; x2: number; y2: number; label?: string; dashed?: boolean; changed?: boolean }
  | { id: string; type: "line"; x1: number; y1: number; x2: number; y2: number; label?: string; dashed?: boolean; changed?: boolean }
  | { id: string; type: "point"; x: number; y: number; label?: string; changed?: boolean };
export type Diagram = { width: number; height: number; elements: DiagramElement[] };
export type VisualStep = { title: string; changes: string[]; reason?: string; diagram?: Diagram; page?: number; quote?: string; matched?: boolean; uncertain?: boolean };
export type VisualItem = {
  id: string;
  number: number;
  title: string;
  kind: VisualKind;
  provenance: VisualProvenance;
  source?: VisualSource;
  image_url?: string;
  body?: string;
  explanation?: string;
  diagram?: Diagram;
  steps?: VisualStep[];
};
