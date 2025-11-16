import { sprintCache } from '../services/sprintDataLoader.js';
import { findWorkItemsByKeyword } from '../services/workItemManager.js';

export function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function childIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .filter(r => r.rel && r.rel.toLowerCase().includes("hierarchy-forward"))
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

export function relatedIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

export function resolveSprintPath(userInput) {
  const sprints = sprintCache?.sprints || [];
  const buckets = sprintCache?.stories || [];
  if (!sprints.length && !buckets.length) return null;

  const raw = String(userInput || "").trim();
  const x = raw
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,)\]]+$/g, "")
    .trim();

  const byNameExact = sprints.find(s => (s.name || "").toLowerCase() === x);
  if (byNameExact?.path) return byNameExact.path;

  const numMatch =
    x.match(/(?:^|[\s\-_])sprint[\s\-_]*([0-9]+)$/i) ||
    x.match(/^([0-9]+)$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      const canonical = `sprint ${n}`;
      const byCanonical = sprints.find(s => (s.name || "").toLowerCase() === canonical);
      if (byCanonical?.path) return byCanonical.path;
      const idx = n - 1;
      const bucket = buckets[idx];
      if (bucket?.path) return bucket.path;
      const meta = sprints[idx];
      if (meta?.path) return meta.path;
    }
  }

  const byNameContains = sprints.find(s => (s.name || "").toLowerCase().includes(x));
  if (byNameContains?.path) return byNameContains.path;

  return null;
}

export async function resolveTitleOrIdWithShortlist(queryText) {
  const t = String(queryText || "").trim();
  const idMatch = t.match(/^\#?(\d+)\b/);
  if (idMatch) return { id: parseInt(idMatch[1], 10), shortlist: [] };

  const norm = t.toLowerCase().replace(/\s+/g, " ").trim();
  const buckets = (sprintCache.stories || []);
  const ordered = [ ...(buckets[0] ? [buckets[0]] : []), ...buckets.slice(1) ];

  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().trim() === norm);
    if (hit) return { id: hit.id, shortlist: [] };
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().startsWith(norm));
    if (hit) return { id: hit.id, shortlist: [] };
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().includes(norm));
    if (hit) return { id: hit.id, shortlist: [] };
  }

  let candidates = [];
  try {
    const results = await findWorkItemsByKeyword(t);
    candidates = results || [];
  } catch {
    candidates = [];
  }

  if (candidates.length) {
    const lower = candidates.map(r => ({ ...r, _t: (r.title || "").toLowerCase() }));
    const pick = lower.find(r => r._t === norm)
      || lower.find(r => r._t.startsWith(norm))
      || lower.find(r => r._t.includes(norm))
      || lower[0];
    const shortlist = lower.slice(0, 3).map(r => ({ id: r.id, title: r.title }));
    return { id: pick?.id || null, shortlist };
  }

  return { id: null, shortlist: [] };
}
