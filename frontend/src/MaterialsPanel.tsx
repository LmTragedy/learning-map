import { useState } from "react";
import { FilePlus2, Pencil, RefreshCw } from "lucide-react";
import { api, materialFileUrl } from "./api";
import { Button } from "./components/ui/button";
import type { Course, Material } from "./types";

type Run = <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
type Parser = "basic" | "docling";

/** Materials saved before the parser was recorded fall back to what their pages say. */
function materialParser(material: Material): Parser {
  if (material.parser) return material.parser;
  return material.pages.some((page) => page.method === "docling") ? "docling" : "basic";
}

function parserLabel(material: Material) {
  if (materialParser(material) === "docling") return "Docling";
  return material.pages.some((page) => page.method.includes("tesseract")) ? "Basic + OCR" : "Basic";
}

const canDocling = (material: Material) => material.kind === "pdf" || material.kind === "image";

export function MaterialsPanel({ course, doclingAvailable, busy, run, onCourse }: {
  course: Course;
  doclingAvailable: boolean;
  busy: boolean;
  run: Run;
  onCourse: (course: Course) => void;
}) {
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [week, setWeek] = useState("");
  const [progress, setProgress] = useState("");
  const pending = course.materials.filter((m) => canDocling(m) && materialParser(m) !== "docling");

  const reparse = (material: Material, parser: Parser) =>
    run(`material-reparse:${material.id}`, () => api.reparseMaterial(course.id, material.id, parser)).then(
      (value) => value && onCourse(value));

  const reparseAll = () => {
    const targets = [...pending];
    void run("material-reparse:all", async () => {
      try {
        for (const [index, material] of targets.entries()) {
          setProgress(`正在用 Docling 解析 ${index + 1}/${targets.length}：${material.name}`);
          onCourse(await api.reparseMaterial(course.id, material.id, "docling"));
        }
      } finally {
        setProgress("");
      }
    });
  };

  const startEdit = (material: Material) => {
    setEditing(material.id);
    setName(material.name);
    setWeek(material.week);
  };

  const saveEdit = (material: Material) =>
    run(`material-edit:${material.id}`, () => api.updateMaterial(course.id, material.id, { name, week })).then(
      (value) => {
        if (!value) return;
        onCourse(value);
        setEditing("");
      });

  if (!course.materials.length) return <div className="modal-body"><p className="muted">还没有导入材料。</p></div>;

  return (
    <div className="modal-body">
      <div className="materials-toolbar">
        <small className="muted">
          {pending.length
            ? `${pending.length} 份 PDF/图片还没有用 Docling 解析。`
            : "所有 PDF/图片都已用 Docling 解析。"}
          {!doclingAvailable && " Docling 未安装：在后端环境运行 pip install docling 后重启服务。"}
          {" "}重新解析只替换提取的文字，原文件、页码和节点引用不变；该材料的页索引会失效，需重新建立。
        </small>
        {pending.length > 0 && (
          <Button variant="outline" size="sm" disabled={busy || !doclingAvailable} onClick={reparseAll}>
            <RefreshCw /> 全部用 Docling 重新解析
          </Button>
        )}
        {progress && <small className="materials-progress">{progress}（每份最长约 2 分钟）</small>}
      </div>
      <div className="materials-list">
        {course.materials.map((material) => (
          <details className="material-card" key={material.id}>
            <summary>
              <FilePlus2 size={14} />
              <span>{material.name}</span>
              <small className="material-parser">{parserLabel(material)}</small>
              <small>{material.week || "未分周"} · {material.pages.length} 页</small>
            </summary>
            <div className="material-actions">
              {editing === material.id ? (
                <form className="material-edit" onSubmit={(event) => { event.preventDefault(); void saveEdit(material); }}>
                  <label className="field-label">文件名
                    <input value={name} maxLength={240} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label className="field-label">周次
                    <input value={week} maxLength={100} placeholder="未分周" onChange={(event) => setWeek(event.target.value)} />
                  </label>
                  <div className="material-edit-buttons">
                    <Button size="sm" type="submit" disabled={busy || !name.trim()}>保存</Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setEditing("")}>取消</Button>
                  </div>
                </form>
              ) : (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => startEdit(material)}>
                    <Pencil /> 编辑信息
                  </Button>
                  {canDocling(material) && (
                    <Button size="sm" variant="ghost" disabled={busy || !doclingAvailable}
                      title={doclingAvailable ? "" : "Docling 未安装"}
                      onClick={() => void reparse(material, "docling")}>
                      <RefreshCw /> {materialParser(material) === "docling" ? "再用 Docling 解析" : "用 Docling 重新解析"}
                    </Button>
                  )}
                  {material.kind !== "text" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reparse(material, "basic")}>
                      <RefreshCw /> 用 Basic 重新解析
                    </Button>
                  )}
                </>
              )}
            </div>
            {material.warnings.length > 0 && (
              <ul className="warning-list">
                {material.warnings.map((warning, index) => (
                  <li key={`${material.id}-warning-${index}`}>{warning}</li>
                ))}
              </ul>
            )}
            <div className="material-pages">
              {material.pages.map((page) => (
                <details key={`${material.id}-${page.number}`}>
                  <summary>
                    第 {page.number} 页 · {page.method}
                    {page.uncertain ? " · 识别不确定" : ""}
                  </summary>
                  <p>{page.text || "此页未提取到文字；请核对原始页面图像。"}</p>
                  {page.warnings.map((warning, index) => (
                    <span className="page-warning" key={`${page.number}-warning-${index}`}>{warning}</span>
                  ))}
                  <a href={materialFileUrl(course.id, material.id, page.number)} target="_blank" rel="noreferrer">
                    打开原始文件第 {page.number} 页
                  </a>
                  <img
                    loading="lazy"
                    src={`/api/courses/${course.id}/materials/${material.id}/pages/${page.number}`}
                    alt={`${material.name} 第 ${page.number} 页原始页面`}
                  />
                </details>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
