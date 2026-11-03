type Vertex = { id: string };
type Link = { source: string; target: string };

function graphLayers(nodes: Vertex[], edges: Link[]) {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const children = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) continue;
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
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
  return { layers: layers.map((layer) => layer ?? []) };
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

export type ForcePoint = { x: number; y: number };

/**
 * Deterministic force-directed layout in the spirit of an Obsidian graph view. Nodes repel each
 * other, prerequisite edges act as springs, and a weak horizontal pull keeps prerequisites to the
 * left of what follows them. Returns node centres. Same input always gives the same picture.
 */
export function forceLayout(nodes: Vertex[], edges: Link[], options: { iterations?: number } = {}) {
  const ids = nodes.map((node) => node.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = edges.filter((edge) => index.has(edge.source) && index.has(edge.target) && edge.source !== edge.target);
  const { layers } = graphLayers(nodes, links);
  const depth = new Map<string, number>();
  layers.forEach((layer, d) => layer.forEach((id) => depth.set(id, d)));
  const maxDepth = Math.max(0, layers.length - 1);
  const SPAN_X = 64;
  // Seed: column by depth, spread rows evenly, so the result is stable and roughly ordered.
  const px = new Float64Array(ids.length);
  const py = new Float64Array(ids.length);
  layers.forEach((layer, d) => layer.forEach((id, row) => {
    const i = index.get(id)!;
    px[i] = (d - maxDepth / 2) * SPAN_X;
    py[i] = (row - (layer.length - 1) / 2) * 46 + ((d % 2) ? 18 : -18);
  }));
  const vx = new Float64Array(ids.length);
  const vy = new Float64Array(ids.length);
  const iterations = options.iterations ?? 420;
  const degree = new Float64Array(ids.length);
  for (const edge of links) { degree[index.get(edge.source)!]++; degree[index.get(edge.target)!]++; }
  for (let step = 0; step < iterations; step++) {
    const alpha = 1 - step / iterations;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (i - j) * 0.5 || 0.5; dy = 0.5; d2 = dx * dx + dy * dy; }
        const force = Math.min(2600 / d2, 30) * alpha;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        vx[i] += fx; vy[i] += fy; vx[j] -= fx; vy[j] -= fy;
      }
    }
    for (const edge of links) {
      const a = index.get(edge.source)!;
      const b = index.get(edge.target)!;
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const pull = (d - 64) * 0.045 * alpha;
      const fx = (dx / d) * pull;
      const fy = (dy / d) * pull;
      const wa = 1 / Math.max(1, degree[a] * 0.6);
      const wb = 1 / Math.max(1, degree[b] * 0.6);
      vx[a] += fx * wa; vy[a] += fy * wa; vx[b] -= fx * wb; vy[b] -= fy * wb;
    }
    for (let i = 0; i < ids.length; i++) {
      const targetX = ((depth.get(ids[i]) ?? 0) - maxDepth / 2) * SPAN_X;
      vx[i] += (targetX - px[i]) * 0.018 * alpha - px[i] * 0.002 * alpha;
      vy[i] += -py[i] * 0.005 * alpha;
      vx[i] *= 0.82; vy[i] *= 0.82;
      px[i] += Math.max(-24, Math.min(24, vx[i]));
      py[i] += Math.max(-24, Math.min(24, vy[i]));
    }
  }
  return new Map(ids.map((id, i) => [id, { x: Math.round(px[i] * 10) / 10, y: Math.round(py[i] * 10) / 10 }] as const));
}
