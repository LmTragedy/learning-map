import { useEffect, useRef } from "react";

/** Tri-state "select all" checkbox for a list of selectable ids. */
export function SelectAll({ ids, selected, onChange, label = "全选", disabled }: {
  ids: readonly string[] | readonly number[];
  selected: readonly (string | number)[];
  onChange: (next: (string | number)[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const box = useRef<HTMLInputElement>(null);
  const chosen = ids.filter((id) => selected.includes(id)).length;
  const all = ids.length > 0 && chosen === ids.length;
  useEffect(() => {
    if (box.current) box.current.indeterminate = chosen > 0 && !all;
  }, [chosen, all]);
  return <label className="select-all">
    <input ref={box} type="checkbox" checked={all} disabled={disabled || !ids.length}
      onChange={() => onChange(all
        ? selected.filter((id) => !(ids as readonly (string | number)[]).includes(id))
        : [...new Set([...selected, ...ids])])} />
    <span>{label}</span>
    <small>已选 {chosen}/{ids.length}</small>
  </label>;
}
