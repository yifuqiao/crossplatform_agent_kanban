import path from "node:path";

export function oneLine(text, max = 120) {
  if (typeof text !== "string") return "";
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", apos: "'" };

// The person's own words from a prompt. Claude project threads wrap every prompt in
// <wake>/<coordinator-relay> XML (sometimes entity-escaped); a card titled with that is unreadable.
// Plain prompts come back unchanged.
export function promptText(prompt) {
  if (typeof prompt !== "string") return "";
  // Only the known envelopes: a coding prompt that merely mentions <tags> or Array<Foo> stays as typed.
  if (!/^\s*(<|&lt;)(wake|coordinator-relay|system-reminder)\b/i.test(prompt)) return prompt;
  const s = prompt
    .replace(/&(lt|gt|amp|quot|#39|apos);/g, (_, e) => ENTITIES[e])
    .replace(/<(system-reminder|system-note|session-context)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, " ");
  const pick = (re) => [...s.matchAll(re)].map((m) => m[1].replace(/<[^>]+>/g, " ").trim()).find(Boolean);
  return pick(/<cited\b[^>]*author="user"[^>]*>([\s\S]*?)<\/cited>/gi)
    || pick(/<message\b[^>]*trigger="true"[^>]*from="human"[^>]*>([\s\S]*?)<\/message>/gi)
    || pick(/<message\b[^>]*from="human"[^>]*>([\s\S]*?)<\/message>/gi)
    || pick(/<note>([\s\S]*?)<\/note>/gi)
    || pick(/<message\b[^>]*>([\s\S]*?)<\/message>/gi)
    || s.replace(/<[^>]+>/g, " ").trim();
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
