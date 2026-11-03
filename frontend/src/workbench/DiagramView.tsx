import { useId, useMemo } from "react";
import { validateDiagram } from "./diagramModel";
import type { Diagram as DiagramModel } from "./visualTypes";

export function DiagramView({ diagram: input, label }: { diagram?: DiagramModel; label?: string }) {
  const diagram = useMemo(() => validateDiagram(input), [input]);
  const markerId = `visual-arrow-${useId().replace(/:/g, "")}`;
  if (!diagram) return <div className="visual-diagram-error" role="status">图形数据无法显示。</div>;
  return <svg className="visual-diagram" viewBox={`0 0 ${diagram.width} ${diagram.height}`} role="img" aria-label={label || "示意图"}>
    <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 z" fill="#8a8a94" /></marker></defs>
    {diagram.elements.map((item) => {
      const common = { className: item.changed ? "visual-shape is-changed" : "visual-shape" };
      if (item.type === "box" || item.type === "cell") return <g key={item.id} {...common}>
        <rect x={item.x} y={item.y} width={item.width} height={item.height} rx={item.type === "box" ? 6 : 0} />
        {item.oldText && <><text className="visual-old" x={item.x + item.width / 2} y={item.y + item.height / 2-6} textAnchor="middle">{item.oldText}</text><line className="visual-strike" x1={item.x + item.width * .2} x2={item.x + item.width * .8} y1={item.y + item.height / 2-10} y2={item.y + item.height / 2-10} /></>}
        {item.text && <text className={item.type === "cell" ? "visual-mono" : ""} x={item.x + item.width / 2} y={item.y + item.height / 2+(item.oldText?12:0)} textAnchor="middle" dominantBaseline="middle">{item.text}</text>}
      </g>;
      if (item.type === "text") return <text key={item.id} {...common} x={item.x} y={item.y}>{item.text}</text>;
      if (item.type === "arrow" || item.type === "line") return <g key={item.id} {...common}><line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2} strokeDasharray={item.dashed ? "4 4" : undefined} markerEnd={item.type === "arrow" ? `url(#${markerId})` : undefined} />{item.label && <text className="visual-label" x={(item.x1 + item.x2) / 2} y={(item.y1 + item.y2) / 2 - 6} textAnchor="middle">{item.label}</text>}</g>;
      return <g key={item.id} {...common}><circle cx={item.x} cy={item.y} r="4" />{item.label && <text className="visual-label" x={item.x + 6} y={item.y - 6}>{item.label}</text>}</g>;
    })}
  </svg>;
}
