import { BookOpen, FileText, X } from "lucide-react";
import type { ReactNode } from "react";

export type SourceTab = { id: string; icon: "lesson" | "material"; label: string; onClose: () => void };

/** Editor-style tabs: the active one is underlined, close buttons show on hover. */
export function SourceTabs({ tabs, active, onActivate, children }: {
  tabs: SourceTab[]; active: string;
  onActivate: (id: string) => void;
  children?: ReactNode;
}) {
  return <div className="wb-tabs" role="tablist" aria-label="打开的材料">
    {tabs.map((tab) => {
      const Icon = tab.icon === "lesson" ? BookOpen : FileText;
      const selected = tab.id === active;
      return <div key={tab.id} className="wb-tab" data-active={selected || undefined}>
        <button role="tab" aria-selected={selected} className="wb-tab-label" title={tab.label} onClick={() => onActivate(tab.id)}>
          <Icon size={14} aria-hidden /><span>{tab.label}</span>
        </button>
        <button className="wb-tab-close" aria-label={`关闭 ${tab.label}`} onClick={tab.onClose}><X size={13} /></button>
      </div>;
    })}
    {children}
  </div>;
}
