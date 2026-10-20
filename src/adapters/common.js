import path from "node:path";

export function oneLine(text, max = 120) {
  if (typeof text !== "string") return "";
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function folder(cwd) {
  return cwd ? path.basename(cwd) : "";
}

// Lets one agent nest under (or report into) a card created by whoever launched it.
//   AKB_TASK_KEY=source:id    report this session into that existing card
//   AKB_PARENT_KEY=source:id  show this session as a child of that card
// `rootKey` is the key the adapter would otherwise use for the session itself.
export function applyEnvLinks(events, rootKey, env = process.env) {
  const target = env.AKB_TASK_KEY;
  const parent = env.AKB_PARENT_KEY;
  return events.map((ev) => {
    const out = { ...ev };
    const key = ev.key || `${ev.source}:${ev.external_id}`;
    if (target && key === rootKey) {
      delete out.source;
      delete out.external_id;
      out.key = target;
    } else if (key === rootKey && parent && !out.parent) {
      out.parent = parent;
    }
    if (target && out.parent === rootKey) out.parent = target;
    return out;
  });
}
