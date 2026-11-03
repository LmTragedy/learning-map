type Vertex = { id: string };
type Link = { source: string; target: string };

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 64;
const COLUMN_PITCH = 264;
const ROW_PITCH = 84;
const STAGE_GAP = 40;
const ORIGIN = { x: 40, y: 72 };

function graphLayers(nodes: Vertex[], edges: Link[]) {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const parents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const children = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) continue;
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    parents.get(edge.target)!.push(edge.source);
    children.get(edge.source)!.push(edge.target);
  }
  const depths = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i])!) {
      depths.set(child, Math.max(depths.get(child)!, depths.get(queue[i])! + 1));
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  const layers: string[][] = [];
  for (const node of nodes) (layers[depths.get(node.id)!] ??= []).push(node.id);
  return { layers: layers.map((layer) => layer ?? []), parents, children };
}

function reorderLayers(layers: string[][], neighbors: Map<string, string[]>, indices: number[]) {
  const ranks = new Map(layers.flatMap((layer) => layer.map((id, i) => [id, i] as const)));
  for (const index of indices) {
    const score = (id: string) => {
      const linked = neighbors.get(id)!;
      return linked.length ? linked.reduce((total, parent) => total + ranks.get(parent)!, 0) / linked.length : ranks.get(id)!;
    };
    layers[index].sort((a, b) => score(a) - score(b) || ranks.get(a)! - ranks.get(b)!);
    layers[index].forEach((id, i) => ranks.set(id, i));
  }
}

/** Place one ordered layer as close as possible to the wanted rows while keeping a full row between nodes. */
function packLayer(layer: string[], wanted: Map<string, number>) {
  const rows = layer.map((id) => wanted.get(id)!);
  for (let i = 1; i < rows.length; i++) rows[i] = Math.max(rows[i], rows[i - 1] + 1);
  // Shift the whole layer back so it sits around the wanted rows instead of drifting downwards.
  const drift = rows.reduce((total, row, i) => total + row - wanted.get(layer[i])!, 0) / Math.max(1, rows.length);
  return rows.map((row) => row - drift);
}

function alignLayers(layers: string[][], parents: Map<string, string[]>, children: Map<string, string[]>) {
  const tallest = Math.max(0, ...layers.map((layer) => layer.length));
  const rows = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((id, i) => rows.set(id, (tallest - layer.length) / 2 + i)));
  const settle = (order: number[], neighbors: Map<string, string[]>) => {
    for (const index of order) {
      const layer = layers[index];
      const wanted = new Map(layer.map((id) => {
        const linked = neighbors.get(id)!.filter((other) => rows.has(other));
        const target = linked.length ? linked.reduce((sum, other) => sum + rows.get(other)!, 0) / linked.length : rows.get(id)!;
        return [id, target] as const;
      }));
      packLayer(layer, wanted).forEach((row, i) => rows.set(layer[i], row));
    }
  };
  const forward = layers.map((_, index) => index);
  for (let pass = 0; pass < 2; pass++) {
    settle(forward.slice(1), parents);
    settle([...forward].reverse().slice(1), children);
  }
  const top = Math.min(0, ...rows.values());
  for (const [id, row] of rows) rows.set(id, row - top);
  return rows;
}

/**
 * Layered positions for the prerequisite graph. Columns follow prerequisite depth; an optional
 * stage lookup inserts a gap whenever a column starts a new stage so stage bands do not touch.
 * The input nodes and edges are never mutated.
 */
export function graphPositions(nodes: Vertex[], edges: Link[], stageOf?: Map<string, string>) {
  const { layers, parents, children } = graphLayers(nodes, edges);
  const forward = layers.map((_, index) => index);
  const backward = [...forward].reverse();
  for (let pass = 0; pass < 3; pass++) {
    reorderLayers(layers, parents, forward);
    reorderLayers(layers, children, backward);
  }
  const rows = alignLayers(layers, parents, children);
  const columnX: number[] = [];
  let x = ORIGIN.x;
  let previousStage: string | undefined;
  layers.forEach((layer, column) => {
    const stage = stageOf?.get(layer[0] ?? "");
    if (column > 0) x += COLUMN_PITCH + (stage !== undefined && stage !== previousStage ? STAGE_GAP : 0);
    columnX[column] = x;
    previousStage = stage;
  });
  return new Map(layers.flatMap((layer, column) => layer.map((id) => [id, {
    x: columnX[column],
    y: ORIGIN.y + rows.get(id)! * ROW_PITCH,
  }] as const)));
}

/** Every node reachable by following edges upstream (prerequisites) or downstream (followers). */
export function lineage(start: string | undefined, edges: Link[]) {
  const up = new Set<string>();
  const down = new Set<string>();
  if (!start) return { up, down };
  const upstream = (node: string) => edges.filter((edge) => edge.target === node).map((edge) => edge.source);
  const downstream = (node: string) => edges.filter((edge) => edge.source === node).map((edge) => edge.target);
  const collect = (seen: Set<string>, step: (node: string) => string[]) => {
    const stack = [start];
    while (stack.length) for (const other of step(stack.pop()!)) {
      if (other === start || seen.has(other)) continue;
      seen.add(other);
      stack.push(other);
    }
  };
  collect(up, upstream);
  collect(down, downstream);
  return { up, down };
}
