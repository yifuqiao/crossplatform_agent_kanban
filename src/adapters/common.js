import path from "node:path";

export function oneLine(text, max = 120) {
  if (typeof text !== "string") return "";
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", apos: "'" };

// Claude project threads wrap every prompt in <wake>/<relay>/<session-context> XML (sometimes
// entity-escaped), and an attached file puts @"path" in front; a card titled with that is unreadable.
const ENVELOPE = /^\s*(<|&lt;)(wake|coordinator-relay|relay|system-reminder|session-context)\b/i;
const ATTACHMENTS = /^(\s*@(?:"[^"]*"|\S+))+\s*/;
const QUOTED_ATTACHMENTS = /^(\s*@"[^"]*")+\s*/;

// The person's own words from a prompt. Plain prompts come back unchanged.
export function promptText(prompt) {
  return promptParts(prompt).text;
}

// { text, human }: human is false when the words are a coordinator's note or other non-person text,
// so a card can take a better title once the person's own message arrives.
export function promptParts(prompt) {
  if (typeof prompt !== "string") return { text: "", human: false };
  const body = prompt.replace(ATTACHMENTS, "");
  // Only the known envelopes: a coding prompt that merely mentions <tags> or Array<Foo> stays as typed.
  // A plain prompt stays as typed, minus quoted @"path" attachments (an @file mention is kept).
  if (!ENVELOPE.test(body)) return { text: prompt.replace(QUOTED_ATTACHMENTS, "") || prompt, human: true };
  const s = body
    .replace(/&(lt|gt|amp|quot|#39|apos);/g, (_, e) => ENTITIES[e])
    .replace(/<(system-reminder|system-note|session-context|untrusted-uploads)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, " ");
  const pick = (re) => [...s.matchAll(re)].map((m) => m[1].replace(/<[^>]+>/g, " ").trim()).find(Boolean);
  const human = pick(/<cited\b[^>]*author="user"[^>]*>([\s\S]*?)<\/cited>/gi)
    || pick(/<message\b[^>]*trigger="true"[^>]*from="human"[^>]*>([\s\S]*?)<\/message>/gi)
    || pick(/<message\b[^>]*from="human"[^>]*>([\s\S]*?)<\/message>/gi);
  if (human) return { text: human, human: true };
  return { text: pick(/<note>([\s\S]*?)<\/note>/gi) || pick(/<message\b[^>]*>([\s\S]*?)<\/message>/gi) || "", human: false };
}

// A title saved by an older hook: raw envelope XML (maybe after @"path" attachments), or nothing.
// The person's words from a stored title or "Prompt: …" timeline line that may have been cut off
// mid-envelope (older hooks kept only the first 100 / 400 characters, so closing tags can be missing).
export function recoverTitle(text) {
  if (typeof text !== "string") return "";
  const body = text.replace(/^Prompt: /, "").replace(ATTACHMENTS, "");
  if (!ENVELOPE.test(body)) return "";
  const s = body.replace(/&(lt|gt|amp|quot|#39|apos);/g, (_, e) => ENTITIES[e])
    .replace(/<(system-reminder|system-note|session-context|untrusted-uploads)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, " ");
  const m = /<cited\b[^>]*author="user"[^>]*>([^<]+)/i.exec(s) || /<message\b[^>]*from="human"[^>]*>([^<]+)/i.exec(s);
  return m ? oneLine(m[1], 100) : "";
}

export function junkTitle(title) {
  if (typeof title !== "string" || !title.trim()) return true;
  return ENVELOPE.test(title.replace(ATTACHMENTS, ""));
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
