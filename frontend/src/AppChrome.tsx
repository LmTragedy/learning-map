import type { ReactNode } from "react";
import { AlertCircle, Archive, CircleHelp, ClipboardList, Clock3, FileSearch, FolderOpen, FolderSync, History, LoaderCircle, NotebookPen, Plus, RotateCcw, Settings2, Target, Trash2, Upload, Waypoints, X } from "lucide-react";
import { AI_KEYS, useBusyActivity, useElapsedSeconds } from "./busyActivity";
import { Button } from "./components/ui/button";
import type { Modal } from "./appLabels";
import type { Preview } from "./types";

/** Pieces of the app shell drawn around the course screen: confirmations, dialog icons, the busy indicator. */
export function ConfirmPreview({
  preview,
  busy,
  onCancel,
  onConfirm,
  confirm,
  icon,
  danger = false,
}: {
  preview: Preview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirm: string;
  icon: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="modal-body">
      <div className={`warning-callout ${danger ? "danger" : ""}`}>
        <AlertCircle size={19} />
        <p>{preview.warning}</p>
      </div>
      <div className="preview-card">
        <strong>{preview.target}</strong>
        {preview.contents?.map((item, i) => (
          <div className="preview-line" key={`${i}-${item}`}>
            {item}
          </div>
        ))}
      </div>
      <div className="decision-row">
        <Button variant="ghost" onClick={onCancel}>返回</Button>
        <Button variant={danger ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>
          {icon}
          {confirm}
        </Button>
      </div>
    </div>
  );
}
export function ModalIcon({ modal: m }: { modal: Modal }) {
  const icons: Record<string, typeof X> = {
    create: Plus,
    import: Upload,
    settings: Settings2,
    profile: Archive,
    versions: History,
    obsidian: FolderSync,
    restore: RotateCcw,
    delete: Trash2,
    recall: Clock3,
    review: FileSearch,
    materials: FolderOpen,
    goals: Target,
    lines: Waypoints,
    "course-notes": NotebookPen,
    problems: ClipboardList,
  };
  const Icon = icons[m || ""] || CircleHelp;
  return <Icon size={18} />;
}
export function BusyIndicator({ label }: { label: string }) {
  const activity = useBusyActivity();
  const seconds = useElapsedSeconds(activity.since);
  return (
    <div className="busy-indicator" role="status">
      <LoaderCircle size={16} />
      {label}
      {seconds >= 2 && <span className="ai-thinking-time">{AI_KEYS.has(activity.key) ? `已思考 ${seconds} 秒` : `${seconds} 秒`}</span>}
    </div>
  );
}
