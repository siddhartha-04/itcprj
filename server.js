
// server.js — Azure DevOps bot + MCP with robust NLQ routing, deterministic fallbacks, resilient sockets, and iteration moves
/*import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

import {
  loadSprintData,
  getCurrentSprintStories,
  getAllSprintsSummary,
  sprintCache,
  searchWorkItems,
} from "./sprintDataLoader.js";
import { createMCPServer } from "./mcpServer.js";
import {
  createUserStory,
  createTask,
  listWorkItems,
  getWorkItem,
  updateWorkItemState,
  findWorkItemsByKeyword,
  listUnassignedInToDo,
  updateWorkItemIteration,
  listItemsInIteration,
  isUnderIterationPath,
} from "./workItemManager.js";
import oauthRouter from "./OAuth.js";
import { queryWithAI, getModelName } from "./Integration.js"; // OpenRouter + DeepSeek (OpenAI-compatible)

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim());

// Keep sockets alive during inactivity
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 67000;
httpServer.requestTimeout = 0;

const io = new Server(httpServer, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT, OPENROUTER_API_KEY } = process.env;
if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  console.error("❌ Missing Azure DevOps config in .env");
  process.exit(1);
}

const AI_ENABLED = !!OPENROUTER_API_KEY;
console.log(AI_ENABLED ? `✨ OpenRouter AI enabled (model: ${getModelName()})` : "ℹ️ AI disabled");

// Process hardening
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

// Routers
app.use("/oauth", oauthRouter);
app.use("", oauthRouter);
app.use("/mcp", createMCPServer());

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    sprintsLoaded: sprintCache.stories.length,
    totalWorkItems: sprintCache.stories.reduce((sum, s) => sum + s.stories.length, 0),
    lastUpdated: sprintCache.lastUpdated,
    aiEnabled: AI_ENABLED,
    aiModel: AI_ENABLED ? getModelName() : null,
  });
});

// Sprint label normalization and resolution
function normalizeSprintLabel(x) {
  return String(x || "")
    .trim()
    .replace(/[“”"']/g, "")
    .replace(/[.:;,)\]]+$/g, "")
    .replace(/^\(/, "")
    .toLowerCase();
}

function resolveSprintPath(userInput) {
  if (!sprintCache?.sprints?.length) return null;
  const x = normalizeSprintLabel(userInput);

  let found = sprintCache.sprints.find((s) => (s.name || "").toLowerCase() === x);
  if (found?.path) return found.path;

  const m = x.match(/sprint\s*(\d+)/i) || x.match(/^(\d+)$/);
  if (m) {
    const guess = `sprint ${m[1]}`;
    found = sprintCache.sprints.find((s) => (s.name || "").toLowerCase() === guess);
    if (found?.path) return found.path;
  }

  found = sprintCache.sprints.find((s) => (s.name || "").toLowerCase().includes(x));
  return found?.path || null;
}

// Build a rich AI context
async function buildAIContext() {
  const ctx = {
    now: new Date().toISOString(),
    totalSprintsCached: sprintCache.stories.length || 0,
    currentSprint: sprintCache.stories[0]?.sprintName || null,
    currentSprintItems: [],
    currentSprintStats: { total: 0, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 },
    lastTwoSprints: [],
    doingByOwner: {},
    unassignedToDoTop: [],
    recentProjectItems: [],
  };

  const cur = sprintCache.stories[0] || null;
  if (cur) {
    ctx.currentSprintItems = cur.stories.slice(0, 20).map(s => ({
      id: s.id, title: s.title, type: s.type, state: s.state,
      assignedTo: s.assignedTo, storyPoints: s.storyPoints || 0, remainingWork: Number(s.remainingWork) || 0
    }));
    const st = { total: cur.stories.length, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 };
    for (const s of cur.stories) {
      if (s.state === "To Do") st.todo++;
      if (s.state === "Doing") st.doing++;
      if (s.state === "Done") st.done++;
      if (s.state === "To Do" && (!s.assignedTo || s.assignedTo === "Unassigned")) st.unassignedTodo++;
      st.remainingWork += Number(s.remainingWork) || 0;
      st.storyPoints += Number(s.storyPoints) || 0;
    }
    ctx.currentSprintStats = st;
  }

  const buckets = (sprintCache.stories || []).slice(0, 2);
  for (const b of buckets) {
    const agg = { sprintName: b.sprintName, items: b.stories.length, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 };
    for (const s of b.stories) {
      if (s.state === "To Do") agg.todo++;
      if (s.state === "Doing") agg.doing++;
      if (s.state === "Done") agg.done++;
      if (s.state === "To Do" && (!s.assignedTo || s.assignedTo === "Unassigned")) agg.unassignedTodo++;
      agg.remainingWork += Number(s.remainingWork) || 0;
      agg.storyPoints += Number(s.storyPoints) || 0;
    }
    ctx.lastTwoSprints.push(agg);
  }

  const all = await listWorkItems("All");
  const doing = all.filter(i => i.state === "Doing");
  const by = {};
  for (const it of doing) {
    const owner = it.assignedTo || "Unassigned";
    if (!by[owner]) by[owner] = [];
    by[owner].push({ id: it.id, title: it.title, type: it.type });
  }
  ctx.doingByOwner = by;

  const unassigned = all.filter(i => i.state === "To Do" && (!i.assignedTo || i.assignedTo === "Unassigned")).slice(0, 15);
  ctx.unassignedToDoTop = unassigned.map(i => ({ id: i.id, title: i.title, type: i.type }));

  ctx.recentProjectItems = all.slice(0, 20).map(i => ({ id: i.id, title: i.title, type: i.type, state: i.state, assignedTo: i.assignedTo }));

  return ctx;
}

// Deterministic summaries
function summarizeTwoSprintsDeterministic() {
  const buckets = (sprintCache.stories || []).slice(0, 2);
  if (!buckets.length) return "⚠️ No sprint data available; add team iterations and assign items, then retry.";
  const lines = [];
  for (const b of buckets) {
    const items = b.stories || [];
    const todo = items.filter(i => i.state === "To Do").length;
    const doing = items.filter(i => i.state === "Doing").length;
    const done = items.filter(i => i.state === "Done").length;
    const unassignedTodo = items.filter(i => i.state === "To Do" && (!i.assignedTo || i.assignedTo === "Unassigned")).length;
    const rem = items.reduce((s, i) => s + (Number(i.remainingWork) || 0), 0);
    const pts = items.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0);
    const risk = [];
    if (doing > done && doing > 0) risk.push("High WIP in Doing");
    if (unassignedTodo > 0) risk.push(`${unassignedTodo} unassigned To Do`);
    if (rem > 0 && done === 0) risk.push("Remaining work with low Done");
    lines.push(`<b>${b.sprintName}</b> — Items: ${items.length}, To Do: ${todo}, Doing: ${doing}, Done: ${done}, Remaining Work: ${rem}, Story Points: ${pts}`);
    lines.push(`Risks: ${risk.length ? risk.join("; ") : "none obvious"}`);
  }
  return lines.join("<br>");
}

async function doingByOwnerDeterministic() {
  const items = await listWorkItems("All");
  const doing = items.filter(i => i.state === "Doing");
  if (!doing.length) return "There are no items in Doing.";
  const map = new Map();
  for (const it of doing) {
    const owner = it.assignedTo || "Unassigned";
    if (!map.has(owner)) map.set(owner, []);
    map.get(owner).push(it);
  }
  let out = "<b>Doing by owner</b><br>";
  for (const [owner, rows] of map.entries()) {
    out += `• ${owner}: ${rows.map(r => `#${r.id} ${r.title}`).join(", ")}<br>`;
  }
  return out;
}

const conversationState = {};

async function handleMessage(sessionId, text) {
  const state = conversationState[sessionId] || { flow: null, temp: {} };
  text = text.trim();
  const T = text.replace(/^[\s"'`“”‘’•\-–—]+/, "").trim();

  // Early help
  if (/^(hi|hello|hey|help)$/i.test(T)) {
    return `👋 Hi — I'm your ${AI_ENABLED ? "AI-powered " : ""}Azure DevOps Assistant!<br><br>
<b>🎯 Create:</b><br>
• create user story — Creates an Issue (Basic)<br>
• create issue — Backlog item<br>
• create task — Guided (Remaining Work)<br>
• create task "Title" — Quick task<br>
• create issue in sprint 2: Title — Create directly in a sprint<br>
• create task in sprint 1: Title — Create directly in a sprint<br><br>
<b>📊 Boards:</b><br>
• current sprint — Show current sprint items<br>
• all sprints — Overview of last 5 sprints<br>
• search work items [keyword] — Search cached + project (fallback)<br><br>
<b>📋 List & View:</b><br>
• list issues / list tasks / list work items<br>
• list items in sprint 2 — Sprint-scoped list<br>
• get item 10 from sprint 2 — Validate item in that sprint<br>
• get [id] or #[id] — View details<br>
• move [id] to [state] — To Do, Doing, Done<br>
• move [id] to sprint 2 — Reassign iteration<br><br>
<b>🔎 Quick checks:</b><br>
• Which items are unassigned in To Do?<br>
• Which issues are unassigned in To Do in sprint 2?<br><br>
💡 Try: list items in sprint 2`;
  }

  // Health
  if (/^health$/i.test(T)) {
    const summary = {
      sprintsLoaded: sprintCache.stories.length,
      totalWorkItems: sprintCache.stories.reduce((sum, s) => sum + s.stories.length, 0),
      lastUpdated: sprintCache.lastUpdated?.toLocaleString(),
      aiEnabled: AI_ENABLED,
      aiModel: AI_ENABLED ? getModelName() : "n/a",
    };
    return `Health: <br>• sprintsLoaded: ${summary.sprintsLoaded}<br>• totalWorkItems: ${summary.totalWorkItems}<br>• lastUpdated: ${summary.lastUpdated || "n/a"}<br>• aiEnabled: ${summary.aiEnabled}<br>• aiModel: ${summary.aiModel}`;
  }

  // Deterministic overviews
  if (/^summariz(e|e the)\s+last\s+(two|2)\s+sprints/i.test(T)) {
    return summarizeTwoSprintsDeterministic();
  }
  if (/^which\s+(tasks|items).+doing.*(who\s+owns|owner)/i.test(T)) {
    return await doingByOwnerDeterministic();
  }

  // Move iteration: "move 7 to sprint 2"
  const moveToSprint = T.match(/^\s*move\s+(\d+)\s+to\s+sprint\s+(.+?)\s*$/i);
  if (moveToSprint) {
    const [, id, label] = moveToSprint;
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    try {
      await updateWorkItemIteration(id, sprintPath);
      return `✅ Moved #${id} to ${label} (Iteration Path: ${sprintPath}).`;
    } catch (e) {
      return `⚠️ Failed to move #${id} to ${label}: ${e.message || e}`;
    }
  }

  // Alias: get items from sprint <label>
  const getItemsSprint = T.match(/^\s*get\s+items?\s+from\s+sprint\s+(.+?)\s*$/i);
  if (getItemsSprint) {
    const label = getItemsSprint[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    const rows = await listItemsInIteration({ iterationPath: sprintPath, type: null });
    return rows.length
      ? `🧾 Work Items in ${label}:<br>${rows.slice(0, 50).map(i => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`
      : `No work items found in ${label}.`;
  }

  // Get item <id> from sprint <label>
  const getFromSprint = T.match(/^\s*get\s+(?:item\s+)?(\d+)\s+from\s+sprint\s+(.+?)\s*$/i);
  if (getFromSprint) {
    const [, id, sprintLabel] = getFromSprint;
    const sprintPath = resolveSprintPath(sprintLabel);
    if (!sprintPath) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const w = await getWorkItem(id);
    if (!w) return `⚠️ Work item #${id} not found.`;
    const itemPath = w.fields["System.IterationPath"] || "";
    if (!isUnderIterationPath(itemPath, sprintPath)) {
      return `⚠️ #${id} is not in ${sprintLabel} (IterationPath: ${itemPath}).`;
    }
    const f = w.fields;
    return `<b>#${id}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}</br>State: ${f["System.State"]}</br>Iteration: ${itemPath}</br><a href="${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_workitems/edit/${id}" target="_blank">Open in ADO</a>`;
  }

  // List items in sprint <label>
  const listInSprint = T.match(/^\s*list\s+(?:items|work\s*items|issues|tasks)\s+in\s+sprint\s+(.+?)\s*$/i);
  if (listInSprint) {
    const label = listInSprint[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    let type = null;
    if (/list\s+issues/i.test(T)) type = "Issue";
    if (/list\s+tasks/i.test(T)) type = "Task";
    const rows = await listItemsInIteration({ iterationPath: sprintPath, type });
    if (!rows.length) return `No ${type || "work items"} found in ${label}.`;
    const head = `🧾 ${type ? `${type}s` : "Work Items"} in ${label}`;
    return `${head}:<br>${rows.slice(0, 50).map((i) => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`;
  }

  // Unassigned in To Do (tolerant)
  const unassignedRe = /^\s*which\s+(items|issues|tasks|work\s*items)\s+are\s+unassigned\s+in\s+to\s*-?\s*do(?:\s+in\s+sprint\s+(.+?))?(?:\s|,|\.|!|$)/i;
  const unassignedMatch = T.match(unassignedRe);
  if (unassignedMatch) {
    try {
      const kindRaw = unassignedMatch[1].toLowerCase();
      const sprintLabel = unassignedMatch[2]?.trim();
      const type = kindRaw.includes("issue") ? "Issue" : kindRaw.includes("task") ? "Task" : null;
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
      }
      const rows = await listUnassignedInToDo({ type, iterationPath });
      if (!rows?.length) {
        return sprintLabel
          ? `There are no unassigned ${type || "items"} in To Do for ${sprintLabel}.`
          : `There are no unassigned ${type || "items"} in To Do.`;
      }
      const heading = sprintLabel ? `Unassigned in <b>To Do</b> (Sprint: ${sprintLabel})` : `Unassigned in <b>To Do</b>`;
      return `${heading}:<br>${rows.map((r) => `#${r.id}: ${r.title} (${r.type})`).join("<br>")}`;
    } catch (e) {
      return `⚠️ Unable to check unassigned To Do items right now: ${e?.message || "unexpected error"}`;
    }
  }

  // Create in sprint
  const createInSprintIssue = T.match(/^create\s+issue\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintIssue) {
    const [, sprintLabel, title] = createInSprintIssue;
    const path = resolveSprintPath(sprintLabel);
    if (!path) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const created = await createUserStory({ title, iterationPath: path });
    return `✅ Created Issue #${created.id} in ${sprintLabel}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
  }
  const createInSprintTask = T.match(/^create\s+task\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintTask) {
    const [, sprintLabel, title] = createInSprintTask;
    const path = resolveSprintPath(sprintLabel);
    if (!path) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const created = await createTask({ title, iterationPath: path });
    return `✅ Created Task #${created.id} in ${sprintLabel}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
  }

  // Deterministic: backlog aligned to sprint goal (heuristic)
  if (/^(from\s+the\s+backlog|which\s+issues).*(align|best\s+align).*(sprint\s+goal)/i.test(T)) {
    const cur = sprintCache.stories[0] || { stories: [] };
    const goalKeywords = (cur.goal || cur.sprintName || "").toLowerCase().split(/\W+/).filter(Boolean);
    const all = await listWorkItems("All");
    const backlog = all.filter(i => i.state === "To Do" && !i.iterationPath);
    const scored = backlog.map(i => {
      const text = `${i.title} ${i.type}`.toLowerCase();
      const score = goalKeywords.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
      return { ...i, score };
    }).sort((a,b) => b.score - a.score || (a.title || "").localeCompare(b.title || ""));
    const top = scored.slice(0, 5);
    if (!top.length) return "No obvious backlog candidates align with the sprint goal right now.";
    return `Backlog items aligned to sprint goal:<br>${top.map(i => `#${i.id}: ${i.title} (${i.type})`).join("<br>")}`;
  }

  // Deterministic: what to pull next
  if (/what\s+should\s+we\s+pull\s+next/i.test(T)) {
    const cur = sprintCache.stories[0] || { stories: [] };
    const candidates = cur.stories.filter(i => i.state === "To Do")
      .sort((a,b) => (a.storyPoints || 0) - (b.storyPoints || 0));
    const pick = candidates.slice(0, 5);
    if (!pick.length) return "No To Do items available to pull next from the current sprint.";
    return `Suggested next items:<br>${pick.map(i => `#${i.id}: ${i.title} [${i.storyPoints || 0} pts]`).join("<br>")}`;
  }

  // Deterministic: risks and blockers
  if (/^(risks|risks\s+and\s+blockers|what\s+are\s+the\s+main\s+risks)/i.test(T)) {
    const cur = sprintCache.stories[0] || { stories: [] };
    const items = cur.stories || [];
    const doing = items.filter(i => i.state === "Doing");
    const done = items.filter(i => i.state === "Done");
    const unassignedTodo = items.filter(i => i.state === "To Do" && (!i.assignedTo || i.assignedTo === "Unassigned"));
    const highRem = items.filter(i => (i.remainingWork || 0) > 0 && i.state !== "Done");
    const risks = [];
    if (doing.length > done.length && doing.length > 0) risks.push("High WIP in Doing vs Done");
    if (unassignedTodo.length) risks.push(`${unassignedTodo.length} unassigned items in To Do`);
    if (highRem.length) risks.push("Remaining work still open close to deadline");
    return risks.length ? `Risks/Blockers:<br>${risks.map(r => `• ${r}`).join("<br>")}` : "No obvious risks detected from current sprint stats.";
  }

  // Deterministic: healthy burndown explanation
  if (/healthy\s+burndown/i.test(T)) {
    return "A healthy burndown trends downward daily with remaining work decreasing steadily after planning, avoiding flat lines until late in the sprint and ending near zero on the final day. It reflects scope stability and regular task completion rather than end‑loaded progress.";
  }

  // Deterministic: backlog vs sprint explanation (two sentences)
  if (/backlog\s+vs\s+sprint|difference\s+between\s+backlog\s+and\s+sprint/i.test(T)) {
    return "The product backlog is the ordered list of work items for the team, while a sprint is a time‑boxed subset of that backlog the team commits to deliver. In Azure Boards, items move from backlog into a specific Iteration Path (sprint) for execution and tracking.";
  }

  // Deterministic: Taskboard scope
  if (/what\s+does\s+the\s+taskboard\s+show|how\s+is\s+it\s+scoped|taskboard/i.test(T)) {
    return "The Taskboard shows work for the selected sprint broken down by state columns and assigned team members, enabling daily tracking of progress. It is scoped by the team’s selected Iteration Path and only displays items scheduled in that sprint.";
  }

  // Deterministic: are we on track?
  if (/are\s+we\s+on\s+track/i.test(T)) {
    const st = await buildAIContext().then(c => c.currentSprintStats);
    if (!st || !st.total) return "Sprint tracking is unavailable yet because no items are found in the current sprint.";
    const coverage = st.done / Math.max(1, st.total);
    const msg = coverage >= 0.5 ? "Likely on track based on Done ratio so far." : "At risk: low Done ratio; consider reducing WIP and assigning unowned To Do.";
    return `Sprint health — Items: ${st.total}, To Do: ${st.todo}, Doing: ${st.doing}, Done: ${st.done}, Remaining Work: ${st.remainingWork}, Story Points: ${st.storyPoints}<br>${msg}`;
  }

  // SEARCH: cache then WIQL fallback (accepts singular/plural)
  const searchRe = /^(search|find)\s+(stories|story|work\s*items?|work\s*item)\b/i;
  if (searchRe.test(T)) {
    const term = T.replace(/^(search|find)\s+(stories|story|work\s*items?|work\s*item)\b/i, "").trim();
    if (!term) return "Please provide a search term. Example: 'search work items login'";
    if (/^\d+$/.test(term)) {
      const w = await getWorkItem(term);
      if (!w) return `⚠️ Work item #${term} not found.`;
      const f = w.fields || {};
      const itemPath = f["System.IterationPath"] || "None";
      return `<b>#${term}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}<br>State: ${f["System.State"]}<br>Iteration: ${itemPath}<br><a href="${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_workitems/edit/${term}" target="_blank">Open in ADO</a>`;
    }
    const cached = searchWorkItems(term);
    if (cached.length) {
      let out = `🔍 <b>Search Results for "${term}"</b> (${cached.length} found)<br><br>`;
      cached.slice(0, 10).forEach((item) => {
        out += `<b>#${item.id}</b>: ${item.title}<br>Type: ${item.type} | State: ${item.state} | Sprint: ${item.sprintName}<br><br>`;
      });
      if (cached.length > 10) out += `<i>Showing first 10 of ${cached.length} results</i>`;
      return out;
    }
    const found = await findWorkItemsByKeyword(term);
    if (found.length) {
      let out = `🔍 <b>Project Search Results for "${term}"</b> (${found.length} found)<br><br>`;
      found.slice(0, 10).forEach((i) => {
        out += `<b>#${i.id}</b>: ${i.title}<br>Type: ${i.type} | State: ${i.state} | Iteration: ${i.iterationPath || "None"}<br><br>`;
      });
      if (found.length > 10) out += `<i>Showing first 10 of ${found.length} results</i>`;
      return out;
    }
    return `🔍 No work items found matching "<b>${term}</b>"`;
  }

  // Listing and details
  const listMatch = T.match(/list\s+(issues|tasks|work items)/i);
  if (listMatch) {
    const typeMap = { issues: "Issue", tasks: "Task", "work items": "All" };
    const type = typeMap[listMatch[1].toLowerCase()];
    const items = await listWorkItems(type);
    return items.length
      ? `🧾 Latest ${type === "All" ? "Work Items" : type + "s"}:<br>${items
          .slice(0, 20)
          .map((i) => `#${i.id}: ${i.title} [${i.state}]`)
          .join("<br>")}`
      : `No ${type === "All" ? "work items" : type + "s"} found.`;
  }

  const getMatch = T.match(/get\s+(\d+)|show\s+(\d+)|#(\d+)/i);
  if (getMatch) {
    const id = getMatch[1] || getMatch[2] || getMatch[3];
    const w = await getWorkItem(id);
    if (!w) return "⚠️ Work item not found.";
    const f = w.fields;
    return `<b>#${id}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}<br>State: ${f["System.State"]}<br>Assigned: ${f["System.AssignedTo"]?.displayName || "Unassigned"}<br><a href="${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_workitems/edit/${id}" target="_blank">Open in ADO</a>`;
  }

  // Move state
  const moveState = T.match(/^\s*move\s+(\d+)\s+to\s+(.+?)\s*$/i);
  if (moveState) {
    const [, id, raw] = moveState;
    const norm = raw.trim().replace(/["'“”]/g, "").toLowerCase();
    const stateMap = {
      todo: "To Do",
      "to do": "To Do",
      "to-do": "To Do",
      doing: "Doing",
      "in progress": "Doing",
      done: "Done",
      completed: "Done",
      complete: "Done",
    };
    const canonical = stateMap[norm] || stateMap[norm.replace(/\s+/g, " ")];
    if (!canonical) return `⚠️ Unknown state "${raw}". Try: To Do, Doing, Done.`;
    try {
      await updateWorkItemState(id, canonical);
      return `✅ Moved #${id} to ${canonical}.`;
    } catch (e) {
      return `⚠️ ${e.message}`;
    }
  }

  // NLQ route to AI (DeepSeek via OpenRouter)
  const isNLQ = /^(what|how|show|tell|explain|who|when|where|which|why|can you|could you|summarize|summarise|list|find|recommend|prioriti[sz]e|analy[sz]e|assess|risks?|blockers?|bugs?|issues?|backlog|sprint|velocity|burndown)/i.test(T);
  if (AI_ENABLED && isNLQ && T.length > 10 && !state.flow) {
    try {
      const aiCtx = await buildAIContext();
      const aiResponse = await queryWithAI(T, aiCtx);
      return `🤖 <b>AI Assistant:</b><br><br>${aiResponse}`;
    } catch {
      // fall through
    }
  }

  // Guided creation (Issue)
  if (/^create (user story|issue)$/i.test(T) || /^(new|add) (user story|issue)$/i.test(T)) {
    state.flow = "story_awaiting_title";
    conversationState[sessionId] = state;
    return "📝 Let's create a backlog item (Issue).<br><br>What's the title?";
  }
  if (state.flow === "story_awaiting_title") {
    state.temp.title = T;
    state.flow = "story_awaiting_description";
    conversationState[sessionId] = state;
    return "Great! Now provide a description (or type 'skip'):";
  }
  if (state.flow === "story_awaiting_description") {
    state.temp.description = T.toLowerCase() === "skip" ? "" : T;
    state.flow = "story_awaiting_acceptance";
    conversationState[sessionId] = state;
    return "Add acceptance criteria (or type 'skip'):";
  }
  if (state.flow === "story_awaiting_acceptance") {
    state.temp.acceptanceCriteria = T.toLowerCase() === "skip" ? "" : T;
    state.flow = "story_awaiting_points";
    conversationState[sessionId] = state;
    return "Estimate points (number) or type 'skip' (Basic may ignore points):";
  }
  if (state.flow === "story_awaiting_points") {
    state.temp.storyPoints = T.toLowerCase() === "skip" ? 0 : parseFloat(T) || 0;
    state.flow = "story_awaiting_assignee";
    conversationState[sessionId] = state;
    return "Who should be assigned? (email/name or 'skip'):";
  }
  if (state.flow === "story_awaiting_assignee") {
    const assignedTo = T.toLowerCase() === "skip" ? "" : T;
    try {
      const created = await createUserStory({
        title: state.temp.title,
        description: state.temp.description,
        acceptanceCriteria: state.temp.acceptanceCriteria,
        storyPoints: state.temp.storyPoints,
        assignedTo,
      });
      state.flow = null;
      state.temp = {};
      conversationState[sessionId] = state;
      return `✅ <b>Backlog item created</b><br>#${created.id}: ${created.fields["System.Title"]}<br><a href="${created._links.html.href}" target="_blank">Open in ADO</a>`;
    } catch {
      state.flow = null;
      return "⚠️ Failed to create item. Please verify permissions and try again.";
    }
  }

  // Task creation flow
  if (/^create task$/i.test(T)) {
    state.flow = "task_awaiting_title";
    conversationState[sessionId] = state;
    return "Sure — what is the task title?";
  }
  const quickTask = T.match(/create\s+task\s+["“](.+?)["”]/i);
  if (quickTask) {
    try {
      const created = await createTask({ title: quickTask[1] });
      return `✅ Created Task #${created.id}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
    } catch {
      return "⚠️ Failed to create task.";
    }
  }
  if (state.flow === "task_awaiting_title") {
    state.temp.title = T;
    state.flow = "task_awaiting_description";
    conversationState[sessionId] = state;
    return "Add a short description (or type 'skip'):";
  }
  if (state.flow === "task_awaiting_description") {
    state.temp.description = T.toLowerCase() === "skip" ? "" : T;
    state.flow = "task_awaiting_assignee";
    conversationState[sessionId] = state;
    return "Who should I assign this to? (email/name or 'skip'):";
  }
  if (state.flow === "task_awaiting_assignee") {
    state.temp.assignedTo = T.toLowerCase() === "skip" ? "" : T;
    state.flow = "task_awaiting_remaining";
    conversationState[sessionId] = state;
    return "Enter Remaining Work (hours) or 'skip':";
  }
  if (state.flow === "task_awaiting_remaining") {
    const remainingWork = T.toLowerCase() === "skip" ? null : parseFloat(T) || null;
    try {
      const created = await createTask({
        title: state.temp.title,
        description: state.temp.description,
        assignedTo: state.temp.assignedTo,
        remainingWork,
      });
      state.flow = null;
      state.temp = {};
      conversationState[sessionId] = state;
      return `✅ Created Task #${created.id}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
    } catch {
      state.flow = null;
      return "⚠️ Error creating task.";
    }
  }

  // Boards: sprints
  if (/current sprint|sprint stories|show sprint|show current sprint items/i.test(T)) {
    return getCurrentSprintStories();
  }
  if (/all sprints|sprint summary|sprint overview/i.test(T)) {
    return getAllSprintsSummary();
  }

  // Fallback nudge
  return "💡 Try: <b>list items in sprint 2</b>, <b>search work item login</b>, or <b>get #10</b>";
}

// Socket.IO
io.on("connection", (socket) => {
  const sessionId = uuidv4();
  console.log("🟢 User connected:", sessionId);

  socket.emit("bot_message", `👋 Hi! I'm your ${AI_ENABLED ? "AI-powered " : ""}Azure DevOps Assistant.<br>Loading sprint data...`);

  setTimeout(() => {
    if (sprintCache.stories.length > 0) {
      socket.emit("bot_message", getAllSprintsSummary());
    } else {
      socket.emit("bot_message", "⚠️ Sprint data is still loading. Please wait...");
    }
    socket.emit("bot_message", "Type <b>help</b> to see what I can do!");
  }, 2000);

  socket.on("user_message", async (text) => {
    try {
      const reply = await handleMessage(sessionId, text);
      socket.emit("bot_message", reply);
    } catch (err) {
      console.error("handleMessage error:", err);
      socket.emit("bot_message", "⚠️ Sorry, something went wrong handling that request. Please try again.");
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", sessionId);
    delete conversationState[sessionId];
  });
});

// Startup
(async () => {
  console.log("🚀 Starting Azure DevOps Assistant with MCP...");
  await loadSprintData();
  setInterval(async () => {
    console.log("🔄 Refreshing sprint data...");
    await loadSprintData();
  }, 15 * 60 * 1000);

  httpServer.listen(PORT, () => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🔌 MCP Server: http://localhost:${PORT}/mcp`);
    console.log(`🔐 OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
    console.log(`📊 Health Check: http://localhost:${PORT}/health`);
    console.log(`✨ AI: ${AI_ENABLED ? `ENABLED (${getModelName()})` : "DISABLED"}`);
    console.log(`${"=".repeat(60)}\n`);
    console.log(`✅ Ready to accept connections!`);
  });
})();*/

// server.js — deterministic Azure Boards (Basic) backend: correct sprint scoping, numeric label resolution, relations, text answers; MCP + AI only for narratives

// server.js — Deterministic Azure Boards assistant with AI narratives (Node.js/Express + Socket.IO)

/*import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

import {
  loadSprintData,
  getCurrentSprintStories,
  getAllSprintsSummary,
  sprintCache,
} from "./sprintDataLoader.js"; // current-first, explicit Iteration Paths [web:195][web:231]

import { createMCPServer } from "./mcpServer.js";
import {
  createUserStory,
  createTask,
  listWorkItems,
  getWorkItem,                // must call Azure DevOps GET workitem?id&$expand=relations [web:586]
  updateWorkItemState,
  findWorkItemsByKeyword,     // WIQL keyword search across project [web:175]
  listUnassignedInToDo,
  updateWorkItemIteration,
  listItemsInIteration,       // WIQL WHERE [System.IterationPath] UNDER '<path>' AND optional type filter [web:231]
} from "./workItemManager.js";
import oauthRouter from "./OAuth.js";
import { queryWithAI, getModelName } from "./Integration.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim());

httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 67000;
httpServer.requestTimeout = 0;

const io = new Server(httpServer, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT, OPENROUTER_API_KEY } = process.env;
if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  console.error("❌ Missing Azure DevOps config in .env");
  process.exit(1);
}

const AI_ENABLED = !!OPENROUTER_API_KEY;
console.log(AI_ENABLED ? `✨ OpenRouter AI enabled (model: ${getModelName()})` : "ℹ️ AI disabled");

// Utils
function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function childIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .filter(r => r.rel && r.rel.toLowerCase().includes("hierarchy-forward"))
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}
function relatedIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

// Sprint label → Iteration Path
function resolveSprintPath(userInput) {
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

// Strong title/ID resolver (cache-first, then WIQL)
async function resolveWorkItemRef(ref) {
  const t = String(ref || "").trim();
  const idMatch = t.match(/^\#?(\d+)\b/);
  if (idMatch) return parseInt(idMatch[1], 10);

  const norm = t.toLowerCase().replace(/\s+/g, " ").trim();

  const buckets = (sprintCache.stories || []);
  const ordered = [ ...(buckets[0] ? [buckets[0]] : []), ...buckets.slice(1) ];

  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().trim() === norm);
    if (hit) return hit.id;
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().startsWith(norm));
    if (hit) return hit.id;
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().includes(norm));
    if (hit) return hit.id;
  }

  const results = await findWorkItemsByKeyword(t); // WIQL project-wide [web:175]
  if (results && results.length) {
    const lower = results.map(r => ({ ...r, _t: (r.title || "").toLowerCase() }));
    const pick = lower.find(r => r._t === norm)
      || lower.find(r => r._t.startsWith(norm))
      || lower.find(r => r._t.includes(norm))
      || lower[0];
    return pick ? pick.id : null;
  }
  return null;
}
async function getCanonicalWI(ref) {
  const id = await resolveWorkItemRef(ref);
  if (!id) return null;
  const wi = await getWorkItem(id); // must be implemented with $expand=relations [web:586]
  return wi || null;
}

// AI context
async function buildAIContext() {
  const ctx = {
    now: new Date().toISOString(),
    totalSprintsCached: sprintCache.stories.length || 0,
    currentSprint: sprintCache.stories[0]?.sprintName || null,
    currentSprintItems: [],
    currentSprintStats: { total: 0, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 },
    lastTwoSprints: [],
  };

  const cur = sprintCache.stories[0] || null;
  if (cur) {
    const st = { total: cur.stories.length, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 };
    for (const s of cur.stories) {
      if (s.state === "To Do") st.todo++;
      if (s.state === "Doing") st.doing++;
      if (s.state === "Done") st.done++;
      if (s.state === "To Do" && (!s.assignedTo || s.assignedTo === "Unassigned")) st.unassignedTodo++;
      st.remainingWork += Number(s.remainingWork) || 0;
      st.storyPoints += Number(s.storyPoints) || 0;
    }
    ctx.currentSprintStats = st;
    ctx.currentSprintItems = cur.stories.slice(0, 20);
  }

  const buckets = (sprintCache.stories || []).slice(0, 2);
  for (const b of buckets) {
    const agg = { sprintName: b.sprintName, items: b.stories.length, todo: 0, doing: 0, done: 0 };
    for (const s of b.stories) {
      if (s.state === "To Do") agg.todo++;
      if (s.state === "Doing") agg.doing++;
      if (s.state === "Done") agg.done++;
    }
    ctx.lastTwoSprints.push(agg);
  }
  return ctx;
}

// Router logic
const conversationState = {};

async function handleMessage(sessionId, text) {
  const state = conversationState[sessionId] || { flow: null, temp: {} };
  text = text.trim();
  const T = text.replace(/^[\s"'`“”‘’•\-–—]+/, "").trim();

  // Help
  if (/^(hi|hello|hey|help)$/i.test(T)) {
    return [
      "👋 Hi — I'm your AI-powered Azure DevOps Assistant!",
      "",
      "🎯 Create:",
      "• create user story — Creates an Issue (Basic)",
      "• create issue — Backlog item",
      "• create task — Guided (Remaining Work)",
      "• create task \"Title\" — Quick task",
      "• create issue in sprint 2: Title — Create directly in a sprint",
      "• create task in sprint 1: Title — Create directly in a sprint",
      "",
      "📊 Boards:",
      "• current sprint — Show current sprint items",
      "• all sprints — Overview of last 5 sprints",
      "• search work items [keyword] — Search cached + project (fallback)",
      "",
      "📋 List & View:",
      "• list issues / list tasks / list work items",
      "• list items in sprint 2 — Sprint-scoped list",
      "• get item 10 from sprint 2 — Validate item in that sprint",
      "• get [id] or #[id] — View details",
      "• move [id] to [state] — To Do, Doing, Done",
      "• move [id] to sprint 2 — Reassign iteration",
      "",
      "🔎 Quick checks:",
      "• Which items are unassigned in To Do?",
      "• Which issues are unassigned in To Do in sprint 2?",
      "",
      "💡 Try: list items in sprint 2",
    ].join("<br>");
  }

  // Open vs closed — current sprint (Basic)
  if (/open\s+vs\s+closed|total\s+number\s+of\s+open\s+vs\s+closed/i.test(T)) {
    const cur = sprintCache.stories[0] || null;
    if (!cur) return "⚠️ No sprint data loaded yet; please wait and try again.";
    const todo = cur.stories.filter(i => i.state === "To Do").length;
    const doing = cur.stories.filter(i => i.state === "Doing").length;
    const done = cur.stories.filter(i => i.state === "Done").length;
    const open = todo + doing;
    return `Open items: ${open} (To Do: ${todo} + Doing: ${doing})<br>Closed items: ${done}`;
  }

  // Show only Issues in sprint <label>
  const showIssuesOnly = T.match(/^show\s+all\s+issues?\s+in\s+sprint\s+(.+?)\s*$/i);
  if (showIssuesOnly) {
    const label = showIssuesOnly[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    const issues = await listItemsInIteration({ iterationPath: sprintPath, type: "Issue" }); // UNDER [web:231]
    if (!issues.length) return `No Issues found in ${label}.`;
    const lines = issues.map(r => `#${r.id}: ${r.title} [${r.state}]`);
    return `🧾 Issues in ${label}:<br>${lines.join("<br>")}`;
  }

  // Show both Issues and Tasks in sprint <label>
  const showAllInSprint = T.match(/^show\s+all\s+issues?\s+and\s+tasks?\s+in\s+sprint\s+(.+?)\s*$/i);
  if (showAllInSprint) {
    const label = showAllInSprint[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    const issues = await listItemsInIteration({ iterationPath: sprintPath, type: "Issue" });
    const tasks  = await listItemsInIteration({ iterationPath: sprintPath, type: "Task"  });
    const fmt = rows => rows.map(r => `#${r.id}: ${r.title} [${r.state}]`).join("<br>");
    return `🧾 Issues in ${label}:<br>${fmt(issues) || "(none)"}<br><br>🧾 Tasks in ${label}:<br>${fmt(tasks) || "(none)"}`;
  }

  // List items/issues/tasks in sprint <label>
  const listInSprint = T.match(/^\s*list\s+(?:items|work\s*items|issues|tasks)\s+in\s+sprint\s+(.+?)\s*$/i);
  if (listInSprint) {
    const label = listInSprint[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    let type = null;
    if (/list\s+issues/i.test(T)) type = "Issue";
    if (/list\s+tasks/i.test(T)) type = "Task";
    const rows = await listItemsInIteration({ iterationPath: sprintPath, type });
    if (!rows.length) return `No ${type || "work items"} found in ${label}.`;
    const head = `🧾 ${type ? `${type}s` : "Work Items"} in ${label}`;
    return `${head}:<br>${rows.map((i) => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`;
  }

  // Describe <id|title>
  const descrRe = /^(?:what\s+(?:is|does)\s+the\s+)?(?:(?:description)|about)\s+(?:of|for)\s+(.+)$/i;
  if (descrRe.test(T) || /^description$/i.test(T)) {
    const q = /^description$/i.test(T) ? "" : T.replace(descrRe, "$1").trim();
    const ref = q || text;
    const wi = await getCanonicalWI(ref);
    if (!wi) return `⚠️ Could not find that work item.`;
    const f = wi.fields || {};
    const desc = stripHtml(f["System.Description"] || f["Microsoft.VSTS.TCM.ReproSteps"] || "");
    return `<b>#${wi.id}: ${f["System.Title"]}</b><br>${desc || "(No description provided)"}`;
  }

  // Child tasks of <id|title>
  const tasksOfRe = /^(?:what\s+is\s+the\s+child\s+task\s+of|(?:list|show)\s+(?:the\s+)?tasks?\s+(?:of|for))\s+(.+)$/i;
  if (tasksOfRe.test(T)) {
    const q = T.replace(tasksOfRe, "$1").trim();
    const wi = await getCanonicalWI(q);
    if (!wi) {
      if (AI_ENABLED) {
        const aiCtx = await buildAIContext();
        const aiResponse = await queryWithAI(`The user asked for child tasks of "${q}", but no parent was found. Provide likely reasons and next steps (try exact title, #ID, or list sprint items).`, aiCtx);
        return `⚠️ Could not find the parent work item.<br><br>🤖 <b>AI Assistant:</b><br><br>${aiResponse}`;
      }
      return `⚠️ Could not find the parent work item.`;
    }
    const childIds = childIdsFromRelations(wi);
    if (!childIds.length) return `No child Tasks found for #${wi.id} ${wi.fields["System.Title"]}.`;

    const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
    const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${childIds.join(",")}&fields=${fields.join(",")}&api-version=7.0`;
    const { default: axios } = await import("axios");
    const { data } = await axios.get(url, { headers: { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"), "Content-Type": "application/json" } });
    const tasks = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Task");
    if (!tasks.length) return `No child Tasks found for #${wi.id} ${wi.fields["System.Title"]}.`;
    const lines = tasks.map(w => `#${w.id} ${w.fields["System.Title"]} [${w.fields["System.State"]}]`);
    return `Child Tasks of #${wi.id} ${wi.fields["System.Title"]}:<br>${lines.join("<br>")}`;
  }

  // Linked bugs to <id|title>
  const linkedBugsRe = /^which\s+bugs?\s+(?:are\s+linked\s+to|link(?:ed)?\s+with)\s+(.+)$/i;
  if (linkedBugsRe.test(T)) {
    const q = T.replace(linkedBugsRe, "$1").trim();
    const wi = await getCanonicalWI(q);
    if (!wi) return `⚠️ Could not find that work item.`;
    const allIds = relatedIdsFromRelations(wi);
    if (!allIds.length) return `No linked Bugs found for #${wi.id}.`;
    const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
    const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${allIds.join(",")}&fields=${fields.join(",")}&api-version=7.0`;
    const { default: axios } = await import("axios");
    const { data } = await axios.get(url, { headers: { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"), "Content-Type": "application/json" } });
    const bugs = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Bug");
    return bugs.length ? `Linked Bugs:<br>${bugs.map(b => `#${b.id} ${b.fields["System.Title"]} [${b.fields["System.State"]}]`).join("<br>")}` : `No linked Bugs found for #${wi.id}.`;
  }

  // Issues with no child tasks (optional sprint)
  const noChildInSprintRe = /^list\s+all\s+issues?\s+that\s+don'?t\s+have\s+any\s+child\s+tasks?(?:\s+in\s+sprint\s+(.+))?$/i;
  if (noChildInSprintRe.test(T)) {
    const sprintLabel = T.replace(noChildInSprintRe, "$1").trim();
    let iterationPath = null;
    if (sprintLabel) {
      iterationPath = resolveSprintPath(sprintLabel);
      if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    } else if (sprintCache.stories[0]?.path) {
      iterationPath = sprintCache.stories[0].path;
    } else {
      return `⚠️ No sprint context available. Try: "in sprint 2".`;
    }

    const issues = await listItemsInIteration({ iterationPath, type: "Issue" });
    if (!issues.length) return `No Issues found in that sprint.`;

    const { default: axios } = await import("axios");
    const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"), "Content-Type": "application/json" };
    const relUrls = issues.map(i => `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${i.id}?api-version=7.0&$expand=relations`);
    const relRes = await Promise.allSettled(relUrls.map(u => axios.get(u, { headers })));
    const noTaskIssues = [];
    for (const rr of relRes) {
      if (rr.status !== "fulfilled") continue;
      const wi = rr.value.data;
      const kids = childIdsFromRelations(wi);
      if (!kids.length) noTaskIssues.push(`#${wi.id} ${wi.fields["System.Title"]}`);
    }
    return noTaskIssues.length ? `Issues without child Tasks:<br>${noTaskIssues.join("<br>")}` : `All Issues in that sprint have child Tasks.`;
  }

  // Unassigned in To Do
  const unassignedRe = /^\s*which\s+(items|issues|tasks|work\s*items)\s+are\s+unassigned\s+in\s+to\s*-?\s*do(?:\s+in\s+sprint\s+(.+?))?(?:\s|,|\.|!|$)/i;
  const unassignedMatch = T.match(unassignedRe);
  if (unassignedMatch) {
    try {
      const kindRaw = unassignedMatch[1].toLowerCase();
      const sprintLabel = unassignedMatch[2]?.trim();
      const type = kindRaw.includes("issue") ? "Issue" : kindRaw.includes("task") ? "Task" : null;
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
      }
      const rows = await listUnassignedInToDo({ type, iterationPath });
      if (!rows?.length) {
        return sprintLabel
          ? `There are no unassigned ${type || "items"} in To Do for ${sprintLabel}.`
          : `There are no unassigned ${type || "items"} in To Do.`;
      }
      const heading = sprintLabel ? `Unassigned in <b>To Do</b> (Sprint: ${sprintLabel})` : `Unassigned in <b>To Do</b>`;
      return `${heading}:<br>${rows.map((r) => `#${r.id}: ${r.title} (${r.type})`).join("<br>")}`;
    } catch (e) {
      return `⚠️ Unable to check unassigned To Do items right now: ${e?.message || "unexpected error"}`;
    }
  }

  // Create in sprint
  const createInSprintIssue = T.match(/^create\s+issue\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintIssue) {
    const [, sprintLabel, title] = createInSprintIssue;
    const path = resolveSprintPath(sprintLabel);
    if (!path) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const created = await createUserStory({ title, iterationPath: path });
    return `✅ Created Issue #${created.id} in ${sprintLabel}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
  }
  const createInSprintTask = T.match(/^create\s+task\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintTask) {
    const [, sprintLabel, title] = createInSprintTask;
    const path = resolveSprintPath(sprintLabel);
    if (!path) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const created = await createTask({ title, iterationPath: path });
    return `✅ Created Task #${created.id} in ${sprintLabel}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
  }

  // Listing (latest)
  const listMatch = T.match(/list\s+(issues|tasks|work items)/i);
  if (listMatch) {
    const typeMap = { issues: "Issue", tasks: "Task", "work items": "All" };
    const type = typeMap[listMatch[1].toLowerCase()];
    const items = await listWorkItems(type);
    return items.length
      ? `🧾 Latest ${type === "All" ? "Work Items" : type + "s"}:<br>${items
          .slice(0, 20)
          .map((i) => `#${i.id}: ${i.title} [${i.state}]`)
          .join("<br>")}`
      : `No ${type === "All" ? "work items" : type + "s"} found.`;
  }

  // Get item by ID
  const getMatch = T.match(/get\s+(\d+)|show\s+(\d+)|#(\d+)/i);
  if (getMatch) {
    const id = getMatch[1] || getMatch[2] || getMatch[3];
    const w = await getWorkItem(id);
    if (!w) return "⚠️ Work item not found.";
    const f = w.fields;
    return `<b>#${id}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}<br>State: ${f["System.State"]}<br>Assigned: ${f["System.AssignedTo"]?.displayName || "Unassigned"}<br><a href="${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_workitems/edit/${id}" target="_blank">Open in ADO</a>`;
  }

  // Move to sprint
  const moveToSprint = T.match(/^\s*move\s+(\d+)\s+to\s+sprint\s+(.+?)\s*$/i);
  if (moveToSprint) {
    const [, id, label] = moveToSprint;
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    try {
      await updateWorkItemIteration(id, sprintPath);
      return `✅ Moved #${id} to ${label} (Iteration Path: ${sprintPath}).`;
    } catch (e) {
      return `⚠️ Failed to move #${id} to ${label}: ${e.message || e}`;
    }
  }

  // Move state (Basic)
  const moveState = T.match(/^\s*move\s+(\d+)\s+to\s+(.+?)\s*$/i);
  if (moveState) {
    const [, id, raw] = moveState;
    const norm = raw.trim().replace(/["'“”]/g, "").toLowerCase();
    const stateMap = {
      todo: "To Do",
      "to do": "To Do",
      "to-do": "To Do",
      doing: "Doing",
      "in progress": "Doing",
      done: "Done",
      completed: "Done",
      complete: "Done",
    };
    const canonical = stateMap[norm] || stateMap[norm.replace(/\s+/g, " ")];
    if (!canonical) return `⚠️ Unknown state "${raw}". Try: To Do, Doing, Done.`;
    try {
      await updateWorkItemState(id, canonical);
      return `✅ Moved #${id} to ${canonical}.`;
    } catch (e) {
      return `⚠️ ${e.message}`;
    }
  }

  // Current/all sprints
  if (/current sprint|sprint stories|show sprint|show current sprint items/i.test(T)) {
    return getCurrentSprintStories();
  }
  if (/all sprints|sprint summary|sprint overview/i.test(T)) {
    return getAllSprintsSummary();
  }

  // AI narrative fallback (planning, strategy, ambiguous questions)
  const isNLQ = /^(what|how|show|tell|explain|who|when|where|which|why|can you|could you|summarize|summarise|list|find|recommend|prioriti[sz]e|analy[sz]e|assess|risks?|blockers?|bugs?|issues?|backlog|sprint|velocity|burndown|launch|rollout|release|country|market)/i.test(T);
  if (AI_ENABLED && isNLQ && T.length > 10 && !state.flow) {
    try {
      const aiCtx = await buildAIContext();
      const aiResponse = await queryWithAI(T, aiCtx);
      return `🤖 <b>AI Assistant:</b><br><br>${aiResponse}`;
    } catch {
      // ignore
    }
  }

  return "💡 Try: list items in sprint 2, describe #28, or list tasks of <title>";
}

// Routers
app.use("/oauth", oauthRouter);
app.use("", oauthRouter);
app.use("/mcp", createMCPServer());

// Socket.IO chat wiring
io.on("connection", (socket) => {
  const sessionId = uuidv4();
  console.log("🟢 User connected:", sessionId);

  socket.emit("bot_message", `Hello! I’m your Azure Boards Assistant.<br>Loading sprint data...`);

  setTimeout(() => {
    if (sprintCache.stories.length > 0) {
      socket.emit("bot_message", getAllSprintsSummary());
    } else {
      socket.emit("bot_message", "⚠️ Sprint data is still loading. Please wait...");
    }
    socket.emit("bot_message", "Type <b>help</b> to see what I can do!");
  }, 2000);

  socket.on("user_message", async (text) => {
    try {
      const reply = await handleMessage(sessionId, text);
      socket.emit("bot_message", reply);
    } catch (err) {
      console.error("handleMessage error:", err);
      socket.emit("bot_message", "⚠️ Sorry, something went wrong handling that request. Please try again.");
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", sessionId);
    delete conversationState[sessionId];
  });
});

// Startup
(async () => {
  console.log("🚀 Starting Azure Boards Assistant (Basic)...");
  await loadSprintData();  // current-first, explicit paths [web:195][web:231]
  setInterval(async () => {
    console.log("🔄 Refreshing sprint data...");
    await loadSprintData();
  }, 15 * 60 * 1000);

  httpServer.listen(PORT, () => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🔌 MCP Server: http://localhost:${PORT}/mcp`);
    console.log(`🔐 OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
    console.log(`📊 Health Check: http://localhost:${PORT}/health`);
    console.log(`✨ AI: ${AI_ENABLED ? `ENABLED (${getModelName()})` : "DISABLED"}`);
    console.log(`${"=".repeat(60)}\n`);
    console.log(`✅ Ready to accept connections!`);
  });
})();*/

// server.js — Azure Boards (Basic) + AI: deterministic facts, narrative fallback only

/*import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

import {
  loadSprintData,
  getCurrentSprintStories,
  getAllSprintsSummary,
  sprintCache,
} from "./sprintDataLoader.js"; // current-first buckets, each with .path [web:195][web:231]
import { createMCPServer } from "./mcpServer.js";
import {
  createUserStory,
  createTask,
  listWorkItems,
  getWorkItem,                // MUST call GET .../workitems/{id}?api-version=7.1&$expand=relations [web:586]
  updateWorkItemState,
  findWorkItemsByKeyword,     // WIQL keyword search (project-wide) [web:175]
  listUnassignedInToDo,
  updateWorkItemIteration,
  listItemsInIteration,       // WIQL WHERE [System.IterationPath] UNDER '<path>' AND optional type [web:231]
} from "./workItemManager.js";
import oauthRouter from "./OAuth.js";
import { queryWithAI, getModelName } from "./Integration.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim());

httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 67000;
httpServer.requestTimeout = 0;

const io = new Server(httpServer, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT, OPENROUTER_API_KEY } = process.env;
if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  console.error("❌ Missing Azure DevOps config in .env");
  process.exit(1);
}

const AI_ENABLED = !!OPENROUTER_API_KEY;
console.log(AI_ENABLED ? `✨ OpenRouter AI enabled (model: ${getModelName()})` : "ℹ️ AI disabled");

// ---- helpers ----
function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function childIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .filter(r => r.rel && r.rel.toLowerCase().includes("hierarchy-forward"))
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}
function relatedIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

// Sprint label → Iteration Path; numeric “1/2” map to cached buckets when names aren’t exact
function resolveSprintPath(userInput) {
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

// Strong title/ID resolution (cache exact/starts-with/contains, then WIQL keyword)
async function resolveWorkItemRef(ref) {
  const t = String(ref || "").trim();
  const idMatch = t.match(/^\#?(\d+)\b/);
  if (idMatch) return parseInt(idMatch[1], 10);

  const norm = t.toLowerCase().replace(/\s+/g, " ").trim();
  const buckets = (sprintCache.stories || []);
  const ordered = [ ...(buckets[0] ? [buckets[0]] : []), ...buckets.slice(1) ];

  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().trim() === norm);
    if (hit) return hit.id;
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().startsWith(norm));
    if (hit) return hit.id;
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().includes(norm));
    if (hit) return hit.id;
  }

  const results = await findWorkItemsByKeyword(t); // WIQL [web:175]
  if (results && results.length) {
    const lower = results.map(r => ({ ...r, _t: (r.title || "").toLowerCase() }));
    const pick = lower.find(r => r._t === norm)
      || lower.find(r => r._t.startsWith(norm))
      || lower.find(r => r._t.includes(norm))
      || lower[0];
    return pick ? pick.id : null;
  }
  return null;
}
async function getCanonicalWI(ref) {
  const id = await resolveWorkItemRef(ref);
  if (!id) return null;
  const wi = await getWorkItem(id); // MUST set $expand=relations in implementation [web:586]
  return wi || null;
}

// AI context (for narratives only)
async function buildAIContext() {
  const ctx = {
    now: new Date().toISOString(),
    totalSprintsCached: sprintCache.stories.length || 0,
    currentSprint: sprintCache.stories[0]?.sprintName || null,
    currentSprintItems: [],
    currentSprintStats: { total: 0, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 },
    lastTwoSprints: [],
  };

  const cur = sprintCache.stories[0] || null;
  if (cur) {
    const st = { total: cur.stories.length, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 };
    for (const s of cur.stories) {
      if (s.state === "To Do") st.todo++;
      if (s.state === "Doing") st.doing++;
      if (s.state === "Done") st.done++;
      if (s.state === "To Do" && (!s.assignedTo || s.assignedTo === "Unassigned")) st.unassignedTodo++;
      st.remainingWork += Number(s.remainingWork) || 0;
      st.storyPoints += Number(s.storyPoints) || 0;
    }
    ctx.currentSprintStats = st;
    ctx.currentSprintItems = cur.stories.slice(0, 20);
  }

  const buckets = (sprintCache.stories || []).slice(0, 2);
  for (const b of buckets) {
    const agg = { sprintName: b.sprintName, items: b.stories.length, todo: 0, doing: 0, done: 0 };
    for (const s of b.stories) {
      if (s.state === "To Do") agg.todo++;
      if (s.state === "Doing") agg.doing++;
      if (s.state === "Done") agg.done++;
    }
    ctx.lastTwoSprints.push(agg);
  }
  return ctx;
}

// ---- main router ----
const conversationState = {};

async function handleMessage(sessionId, text) {
  const state = conversationState[sessionId] || { flow: null, temp: {} };
  text = text.trim();
  const T = text.replace(/^[\s"'`“”‘’•\-–—]+/, "").trim();

  // Help
  if (/^(hi|hello|hey|help)$/i.test(T)) {
    return [
      "👋 Hi — I'm your AI-powered Azure DevOps Assistant!",
      "",
      "🎯 Create:",
      "• create user story — Creates an Issue (Basic)",
      "• create issue — Backlog item",
      "• create task — Guided (Remaining Work)",
      "• create task \"Title\" — Quick task",
      "• create issue in sprint 2: Title — Create directly in a sprint",
      "• create task in sprint 1: Title — Create directly in a sprint",
      "",
      "📊 Boards:",
      "• current sprint — Show current sprint items",
      "• all sprints — Overview of last 5 sprints",
      "• search work items [keyword] — Search cached + project (fallback)",
      "",
      "📋 List & View:",
      "• list issues / list tasks / list work items",
      "• list items in sprint 2 — Sprint-scoped list",
      "• get item 10 from sprint 2 — Validate item in that sprint",
      "• get [id] or #[id] — View details",
      "• move [id] to [state] — To Do, Doing, Done",
      "• move [id] to sprint 2 — Reassign iteration",
      "",
      "🔎 Quick checks:",
      "• Which items are unassigned in To Do?",
      "• Which issues are unassigned in To Do in sprint 2?",
      "",
      "💡 Try: list items in sprint 2",
    ].join("<br>");
  }

  // Open vs closed — Basic
  if (/open\s+vs\s+closed|total\s+number\s+of\s+open\s+vs\s+closed/i.test(T)) {
    const cur = sprintCache.stories[0] || null;
    if (!cur) return "⚠️ No sprint data loaded yet; please wait and try again.";
    const todo = cur.stories.filter(i => i.state === "To Do").length;
    const doing = cur.stories.filter(i => i.state === "Doing").length;
    const done = cur.stories.filter(i => i.state === "Done").length;
    const open = todo + doing;
    return `Open items: ${open} (To Do: ${todo} + Doing: ${doing})<br>Closed items: ${done}`;
  }

  // Show Issues in sprint <label>
  const showIssuesOnly = T.match(/^show\s+all\s+issues?\s+in\s+sprint\s+(.+?)\s*$/i);
  if (showIssuesOnly) {
    const label = showIssuesOnly[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    const issues = await listItemsInIteration({ iterationPath: sprintPath, type: "Issue" });
    if (!issues.length) return `No Issues found in ${label}.`;
    const lines = issues.map(r => `#${r.id}: ${r.title} [${r.state}]`);
    return `🧾 Issues in ${label}:<br>${lines.join("<br>")}`;
  }

  // Show Issues and Tasks in sprint <label>
  const showAllInSprint = T.match(/^show\s+all\s+issues?\s+and\s+tasks?\s+in\s+sprint\s+(.+?)\s*$/i);
  if (showAllInSprint) {
    const label = showAllInSprint[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    const issues = await listItemsInIteration({ iterationPath: sprintPath, type: "Issue" });
    const tasks  = await listItemsInIteration({ iterationPath: sprintPath, type: "Task"  });
    const fmt = rows => rows.map(r => `#${r.id}: ${r.title} [${r.state}]`).join("<br>");
    return `🧾 Issues in ${label}:<br>${fmt(issues) || "(none)"}<br><br>🧾 Tasks in ${label}:<br>${fmt(tasks) || "(none)"}`;
  }

  // List in sprint <label>
  const listInSprint = T.match(/^\s*list\s+(?:items|work\s*items|issues|tasks)\s+in\s+sprint\s+(.+?)\s*$/i);
  if (listInSprint) {
    const label = listInSprint[1];
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    let type = null;
    if (/list\s+issues/i.test(T)) type = "Issue";
    if (/list\s+tasks/i.test(T)) type = "Task";
    const rows = await listItemsInIteration({ iterationPath: sprintPath, type });
    if (!rows.length) return `No ${type || "work items"} found in ${label}.`;
    const head = `🧾 ${type ? `${type}s` : "Work Items"} in ${label}`;
    return `${head}:<br>${rows.map((i) => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`;
  }

  // Describe <id|title>
  const descrRe = /^(?:what\s+(?:is|does)\s+the\s+)?(?:(?:description)|about)\s+(?:of|for)\s+(.+)$/i;
  if (descrRe.test(T) || /^description$/i.test(T)) {
    const q = /^description$/i.test(T) ? "" : T.replace(descrRe, "$1").trim();
    const ref = q || text;
    const wi = await getCanonicalWI(ref);
    if (!wi) return `⚠️ Could not find that work item.`;
    const f = wi.fields || {};
    const desc = stripHtml(f["System.Description"] || f["Microsoft.VSTS.TCM.ReproSteps"] || "");
    return `<b>#${wi.id}: ${f["System.Title"]}</b><br>${desc || "(No description provided)"}`;
  }

  // Child tasks of <id|title>
  const tasksOfRe = /^(?:what\s+is\s+the\s+child\s+task\s+of|(?:list|show)\s+(?:the\s+)?tasks?\s+(?:of|for))\s+(.+)$/i;
  if (tasksOfRe.test(T)) {
    const q = T.replace(tasksOfRe, "$1").trim();
    const wi = await getCanonicalWI(q);
    if (!wi) {
      if (AI_ENABLED) {
        const aiCtx = await buildAIContext();
        const aiResponse = await queryWithAI(`Parent not found when listing child tasks for "${q}". Explain likely reasons and next steps.`, aiCtx);
        return `⚠️ Could not find the parent work item.<br><br>🤖 <b>AI Assistant:</b><br><br>${aiResponse}`;
      }
      return `⚠️ Could not find the parent work item.`;
    }
    const childIds = childIdsFromRelations(wi);
    if (!childIds.length) return `No child Tasks found for #${wi.id} ${wi.fields["System.Title"]}.`;

    const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
    const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${childIds.join(",")}&fields=${fields.join(",")}&api-version=7.0`;
    const { default: axios } = await import("axios");
    const { data } = await axios.get(url, { headers: { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"), "Content-Type": "application/json" } });
    const tasks = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Task");
    if (!tasks.length) return `No child Tasks found for #${wi.id} ${wi.fields["System.Title"]}.`;
    const lines = tasks.map(w => `#${w.id} ${w.fields["System.Title"]} [${w.fields["System.State"]}]`);
    return `Child Tasks of #${wi.id} ${wi.fields["System.Title"]}:<br>${lines.join("<br>")}`;
  }

  // Linked bugs
  const linkedBugsRe = /^which\s+bugs?\s+(?:are\s+linked\s+to|link(?:ed)?\s+with)\s+(.+)$/i;
  if (linkedBugsRe.test(T)) {
    const q = T.replace(linkedBugsRe, "$1").trim();
    const wi = await getCanonicalWI(q);
    if (!wi) return `⚠️ Could not find that work item.`;
    const allIds = relatedIdsFromRelations(wi);
    if (!allIds.length) return `No linked Bugs found for #${wi.id}.`;
    const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
    const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${allIds.join(",")}&fields=${fields.join(",")}&api-version=7.0`;
    const { default: axios } = await import("axios");
    const { data } = await axios.get(url, { headers: { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"), "Content-Type": "application/json" } });
    const bugs = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Bug");
    return bugs.length ? `Linked Bugs:<br>${bugs.map(b => `#${b.id} ${b.fields["System.Title"]} [${b.fields["System.State"]}]`).join("<br>")}` : `No linked Bugs found for #${wi.id}.`;
  }

  // Issues with no child tasks
  const noChildInSprintRe = /^list\s+all\s+issues?\s+that\s+don'?t\s+have\s+any\s+child\s+tasks?(?:\s+in\s+sprint\s+(.+))?$/i;
  if (noChildInSprintRe.test(T)) {
    const sprintLabel = T.replace(noChildInSprintRe, "$1").trim();
    let iterationPath = null;
    if (sprintLabel) {
      iterationPath = resolveSprintPath(sprintLabel);
      if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    } else if (sprintCache.stories[0]?.path) {
      iterationPath = sprintCache.stories[0].path;
    } else {
      return `⚠️ No sprint context available. Try: "in sprint 2".`;
    }

    const issues = await listItemsInIteration({ iterationPath, type: "Issue" });
    if (!issues.length) return `No Issues found in that sprint.`;

    const { default: axios } = await import("axios");
    const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"), "Content-Type": "application/json" };
    const relUrls = issues.map(i => `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${i.id}?api-version=7.0&$expand=relations`);
    const relRes = await Promise.allSettled(relUrls.map(u => axios.get(u, { headers })));
    const noTaskIssues = [];
    for (const rr of relRes) {
      if (rr.status !== "fulfilled") continue;
      const wi = rr.value.data;
      const kids = childIdsFromRelations(wi);
      if (!kids.length) noTaskIssues.push(`#${wi.id} ${wi.fields["System.Title"]}`);
    }
    return noTaskIssues.length ? `Issues without child Tasks:<br>${noTaskIssues.join("<br>")}` : `All Issues in that sprint have child Tasks.`;
  }

  // Unassigned in To Do
  const unassignedRe = /^\s*which\s+(items|issues|tasks|work\s*items)\s+are\s+unassigned\s+in\s+to\s*-?\s*do(?:\s+in\s+sprint\s+(.+?))?(?:\s|,|\.|!|$)/i;
  const unassignedMatch = T.match(unassignedRe);
  if (unassignedMatch) {
    try {
      const kindRaw = unassignedMatch[1].toLowerCase();
      const sprintLabel = unassignedMatch[2]?.trim();
      const type = kindRaw.includes("issue") ? "Issue" : kindRaw.includes("task") ? "Task" : null;
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
      }
      const rows = await listUnassignedInToDo({ type, iterationPath });
      if (!rows?.length) {
        return sprintLabel
          ? `There are no unassigned ${type || "items"} in To Do for ${sprintLabel}.`
          : `There are no unassigned ${type || "items"} in To Do.`;
      }
      const heading = sprintLabel ? `Unassigned in <b>To Do</b> (Sprint: ${sprintLabel})` : `Unassigned in <b>To Do</b>`;
      return `${heading}:<br>${rows.map((r) => `#${r.id}: ${r.title} (${r.type})`).join("<br>")}`;
    } catch (e) {
      return `⚠️ Unable to check unassigned To Do items right now: ${e?.message || "unexpected error"}`;
    }
  }

  // Create in sprint
  const createInSprintIssue = T.match(/^create\s+issue\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintIssue) {
    const [, sprintLabel, title] = createInSprintIssue;
    const path = resolveSprintPath(sprintLabel);
    if (!path) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const created = await createUserStory({ title, iterationPath: path });
    return `✅ Created Issue #${created.id} in ${sprintLabel}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
  }
  const createInSprintTask = T.match(/^create\s+task\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintTask) {
    const [, sprintLabel, title] = createInSprintTask;
    const path = resolveSprintPath(sprintLabel);
    if (!path) return `⚠️ Sprint "${sprintLabel}" not found; add/select it under Team Settings → Iterations.`;
    const created = await createTask({ title, iterationPath: path });
    return `✅ Created Task #${created.id} in ${sprintLabel}: <a href="${created._links.html.href}" target="_blank">Open</a>`;
  }

  // Latest lists
  const listMatch = T.match(/list\s+(issues|tasks|work items)/i);
  if (listMatch) {
    const typeMap = { issues: "Issue", tasks: "Task", "work items": "All" };
    const type = typeMap[listMatch[1].toLowerCase()];
    const items = await listWorkItems(type);
    return items.length
      ? `🧾 Latest ${type === "All" ? "Work Items" : type + "s"}:<br>${items
          .slice(0, 20)
          .map((i) => `#${i.id}: ${i.title} [${i.state}]`)
          .join("<br>")}`
      : `No ${type === "All" ? "work items" : type + "s"} found.`;
  }

  // Get item by ID
  const getMatch = T.match(/get\s+(\d+)|show\s+(\d+)|#(\d+)/i);
  if (getMatch) {
    const id = getMatch[1] || getMatch[2] || getMatch[3];
    const w = await getWorkItem(id);
    if (!w) return "⚠️ Work item not found.";
    const f = w.fields;
    return `<b>#${id}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}<br>State: ${f["System.State"]}<br>Assigned: ${f["System.AssignedTo"]?.displayName || "Unassigned"}<br><a href="${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_workitems/edit/${id}" target="_blank">Open in ADO</a>`;
  }

  // Move to sprint
  const moveToSprint = T.match(/^\s*move\s+(\d+)\s+to\s+sprint\s+(.+?)\s*$/i);
  if (moveToSprint) {
    const [, id, label] = moveToSprint;
    const sprintPath = resolveSprintPath(label);
    if (!sprintPath) return `⚠️ Sprint "${label}" not found; add/select it under Team Settings → Iterations.`;
    try {
      await updateWorkItemIteration(id, sprintPath);
      return `✅ Moved #${id} to ${label} (Iteration Path: ${sprintPath}).`;
    } catch (e) {
      return `⚠️ Failed to move #${id} to ${label}: ${e.message || e}`;
    }
  }

  // Move state (Basic)
  const moveState = T.match(/^\s*move\s+(\d+)\s+to\s+(.+?)\s*$/i);
  if (moveState) {
    const [, id, raw] = moveState;
    const norm = raw.trim().replace(/["'“”]/g, "").toLowerCase();
    const stateMap = {
      todo: "To Do",
      "to do": "To Do",
      "to-do": "To Do",
      doing: "Doing",
      "in progress": "Doing",
      done: "Done",
      completed: "Done",
      complete: "Done",
    };
    const canonical = stateMap[norm] || stateMap[norm.replace(/\s+/g, " ")];
    if (!canonical) return `⚠️ Unknown state "${raw}". Try: To Do, Doing, Done.`;
    try {
      await updateWorkItemState(id, canonical);
      return `✅ Moved #${id} to ${canonical}.`;
    } catch (e) {
      return `⚠️ ${e.message}`;
    }
  }

  // Current/all sprints
  if (/current sprint|sprint stories|show sprint|show current sprint items/i.test(T)) {
    return getCurrentSprintStories();
  }
  if (/all sprints|sprint summary|sprint overview/i.test(T)) {
    return getAllSprintsSummary();
  }

  // AI narrative fallback — keep last; widened to include prioritization
  const isNLQ = /^(what|how|show|tell|explain|who|when|where|which|why|can you|could you|summari[sz]e|list|find|recommend|prioriti[sz]e|first|next|order|sequence|analy[sz]e|assess|risks?|blockers?|bugs?|issues?|backlog|sprint|velocity|burndown|launch|rollout|release|country|market)/i.test(T);
  if (AI_ENABLED && isNLQ && T.length > 10 && !state.flow) {
    try {
      const aiCtx = await buildAIContext();
      const aiResponse = await queryWithAI(T, aiCtx);
      return `🤖 <b>AI Assistant:</b><br><br>${aiResponse}`;
    } catch {
      // ignore
    }
  }

  return "💡 Try: list items in sprint 2, describe #28, or list tasks of <title>";
}

// Routes and sockets
app.use("/oauth", oauthRouter);
app.use("", oauthRouter);
app.use("/mcp", createMCPServer());

io.on("connection", (socket) => {
  const sessionId = uuidv4();
  console.log("🟢 User connected:", sessionId);

  socket.emit("bot_message", `Hello! I’m your Azure Boards Assistant.<br>Loading sprint data...`);

  setTimeout(() => {
    if (sprintCache.stories.length > 0) {
      socket.emit("bot_message", getAllSprintsSummary());
    } else {
      socket.emit("bot_message", "⚠️ Sprint data is still loading. Please wait...");
    }
    socket.emit("bot_message", "Type <b>help</b> to see what I can do!");
  }, 2000);

  socket.on("user_message", async (text) => {
    try {
      const reply = await handleMessage(sessionId, text);
      socket.emit("bot_message", reply);
    } catch (err) {
      console.error("handleMessage error:", err);
      socket.emit("bot_message", "⚠️ Sorry, something went wrong handling that request. Please try again.");
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", sessionId);
    delete conversationState[sessionId];
  });
});

// Startup
(async () => {
  console.log("🚀 Starting Azure Boards Assistant (Basic)...");
  await loadSprintData(); // loads true current-first and caches Iteration Paths [web:195][web:231]
  setInterval(async () => {
    console.log("🔄 Refreshing sprint data...");
    await loadSprintData();
  }, 15 * 60 * 1000);

  httpServer.listen(PORT, () => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🔌 MCP Server: http://localhost:${PORT}/mcp`);
    console.log(`🔐 OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
    console.log(`📊 Health Check: http://localhost:${PORT}/health`);
    console.log(`✨ AI: ${AI_ENABLED ? `ENABLED (${getModelName()})` : "DISABLED"}`);
    console.log(`${"=".repeat(60)}\n`);
    console.log(`✅ Ready to accept connections!`);
  });
})();*/
// server.js — Azure Boards assistant with deterministic data + AI fallback (Node.js/Express + Socket.IO)

/*import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

import {
  loadSprintData,
  getCurrentSprintStories,
  getAllSprintsSummary,
  sprintCache,
} from "./sprintDataLoader.js";

import {
  createUserStory,
  createTask,
  listWorkItems,
  getWorkItem, // MUST include ?$expand=relations in implementation
  updateWorkItemState,
  findWorkItemsByKeyword,
  listUnassignedInToDo,
  updateWorkItemIteration,
  listItemsInIteration,
} from "./workItemManager.js";

import { queryWithAI, getModelName } from "./Integration.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim());

httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 67000;
httpServer.requestTimeout = 0;

const io = new Server(httpServer, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT, OPENROUTER_API_KEY } = process.env;
if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  console.error("❌ Missing Azure DevOps config in .env (AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT)");
  process.exit(1);
}

const AI_ENABLED = !!OPENROUTER_API_KEY;
console.log(AI_ENABLED ? `✨ OpenRouter AI enabled (model: ${getModelName()})` : "ℹ️ AI disabled");

// ------- Utilities -------
function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function childIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .filter(r => r.rel && r.rel.toLowerCase().includes("hierarchy-forward"))
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

function relatedIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

// Map “Sprint 2” or “2” to an Iteration Path from the cache
function resolveSprintPath(userInput) {
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

  // exact name match
  const byNameExact = sprints.find(s => (s.name || "").toLowerCase() === x);
  if (byNameExact?.path) return byNameExact.path;

  // numeric hint
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

  // contains match
  const byNameContains = sprints.find(s => (s.name || "").toLowerCase().includes(x));
  if (byNameContains?.path) return byNameContains.path;

  return null;
}

// Cache-first title/ID resolution then WIQL project-wide
async function resolveWorkItemRef(ref) {
  const t = String(ref || "").trim();
  const idMatch = t.match(/^\#?(\d+)\b/);
  if (idMatch) return parseInt(idMatch[1], 10);

  const norm = t.toLowerCase().replace(/\s+/g, " ").trim();
  const buckets = (sprintCache.stories || []);
  const ordered = [ ...(buckets[0] ? [buckets[0]] : []), ...buckets.slice(1) ];

  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().trim() === norm);
    if (hit) return hit.id;
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().startsWith(norm));
    if (hit) return hit.id;
  }
  for (const b of ordered) {
    const hit = (b.stories || []).find(s => (s.title || "").toLowerCase().includes(norm));
    if (hit) return hit.id;
  }

  try {
    const results = await findWorkItemsByKeyword(t);
    if (results && results.length) {
      const lower = results.map(r => ({ ...r, _t: (r.title || "").toLowerCase() }));
      const pick = lower.find(r => r._t === norm)
        || lower.find(r => r._t.startsWith(norm))
        || lower.find(r => r._t.includes(norm))
        || lower[0];
      return pick ? pick.id : null;
    }
  } catch {
    // If ADO is unreachable, let caller decide
    return null;
  }
  return null;
}

async function getCanonicalWI(ref) {
  const id = await resolveWorkItemRef(ref);
  if (!id) return null;
  try {
    const wi = await getWorkItem(id); // includes $expand=relations
    return wi || null;
  } catch {
    return null;
  }
}

// AI context kept compact
async function buildAIContext() {
  const ctx = {
    now: new Date().toISOString(),
    totalSprintsCached: sprintCache.stories.length || 0,
    currentSprint: sprintCache.stories[0]?.sprintName || null,
    currentSprintItems: [],
    currentSprintStats: { total: 0, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 },
    lastTwoSprints: [],
  };

  const cur = sprintCache.stories[0] || null;
  if (cur) {
    const st = { total: cur.stories.length, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 };
    for (const s of cur.stories) {
      if (s.state === "To Do") st.todo++;
      if (s.state === "Doing") st.doing++;
      if (s.state === "Done") st.done++;
      if (s.state === "To Do" && (!s.assignedTo || s.assignedTo === "Unassigned")) st.unassignedTodo++;
      st.remainingWork += Number(s.remainingWork) || 0;
      st.storyPoints += Number(s.storyPoints) || 0;
    }
    ctx.currentSprintStats = st;
    ctx.currentSprintItems = cur.stories.slice(0, 8);
  }

  const buckets = (sprintCache.stories || []).slice(0, 2);
  for (const b of buckets) {
    const agg = { sprintName: b.sprintName, items: b.stories.length, todo: 0, doing: 0, done: 0 };
    for (const s of b.stories) {
      if (s.state === "To Do") agg.todo++;
      if (s.state === "Doing") agg.doing++;
      if (s.state === "Done") agg.done++;
    }
    ctx.lastTwoSprints.push(agg);
  }
  return ctx;
}

// ------- Router -------
const conversationState = {};

async function handleMessage(sessionId, text) {
  const state = conversationState[sessionId] || { flow: null, temp: {} };
  text = text.trim();
  const T = text.replace(/^[\s"'`“”‘’•\-–—]+/, "").trim();

  // Help
  if (/^(hi|hello|hey|help)$/i.test(T)) {
    return [
      "👋 Hi — I'm your Azure DevOps Assistant!",
      "",
      "📊 Boards:",
      "• current sprint",
      "• all sprints",
      "• open vs closed this sprint",
      "• list items in sprint 2",
      "• list issues in sprint 1",
      "• list tasks in sprint 2",
      "",
      "🔍 Items:",
      "• describe #28",
      "• list tasks of #28",
      "• which bugs are linked to #28",
      "",
      "✏️ Create/Move:",
      "• create issue in sprint 2: Title",
      "• create task in sprint 1: Title",
      "• move 28 to Doing",
      "• move 29 to sprint 2",
      "",
      "💡 AI:",
      "• what tasks should be completed first",
      "• when should we launch sprint 1 in other countries",
    ].join("<br>");
  }

  // Open vs closed (Basic)
  if (/open\s+vs\s+closed|total\s+number\s+of\s+open\s+vs\s+closed/i.test(T)) {
    const cur = sprintCache.stories[0] || null;
    if (!cur) return "⚠️ No sprint data loaded yet; please wait and try again.";
    const todo = cur.stories.filter(i => i.state === "To Do").length;
    const doing = cur.stories.filter(i => i.state === "Doing").length;
    const done = cur.stories.filter(i => i.state === "Done").length;
    const open = todo + doing;
    return `Open items: ${open} (To Do: ${todo} + Doing: ${doing})<br>Closed items: ${done}`;
  }

  // Sprint views
  const showIssuesOnly = T.match(/^show\s+all\s+issues?\s+in\s+sprint\s+(.+?)\s*$/i);
  if (showIssuesOnly) {
    try {
      const label = showIssuesOnly[1];
      const sprintPath = resolveSprintPath(label);
      if (!sprintPath) return `⚠️ Sprint "${label}" not found; check Team Settings → Iterations.`;
      const issues = await listItemsInIteration({ iterationPath: sprintPath, type: "Issue" });
      if (!issues.length) return `No Issues found in ${label}.`;
      const lines = issues.map(r => `#${r.id}: ${r.title} [${r.state}]`);
      return `🧾 Issues in ${label}:<br>${lines.join("<br>")}`;
    } catch (e) {
      return `⚠️ Unable to list issues: ${e?.message || "unexpected error"}`;
    }
  }

  const showAllInSprint = T.match(/^show\s+all\s+issues?\s+and\s+tasks?\s+in\s+sprint\s+(.+?)\s*$/i);
  if (showAllInSprint) {
    try {
      const label = showAllInSprint[1];
      const sprintPath = resolveSprintPath(label);
      if (!sprintPath) return `⚠️ Sprint "${label}" not found; check Team Settings → Iterations.`;
      const issues = await listItemsInIteration({ iterationPath: sprintPath, type: "Issue" });
      const tasks  = await listItemsInIteration({ iterationPath: sprintPath, type: "Task"  });
      const fmt = rows => rows.map(r => `#${r.id}: ${r.title} [${r.state}]`).join("<br>");
      return `🧾 Issues in ${label}:<br>${fmt(issues) || "(none)"}<br><br>🧾 Tasks in ${label}:<br>${fmt(tasks) || "(none)"}`;
    } catch (e) {
      return `⚠️ Unable to list sprint items: ${e?.message || "unexpected error"}`;
    }
  }

  const listInSprint = T.match(/^\s*list\s+(?:items|work\s*items|issues|tasks)\s+in\s+sprint\s+(.+?)\s*$/i);
  if (listInSprint) {
    try {
      const label = listInSprint[1];
      const sprintPath = resolveSprintPath(label);
      if (!sprintPath) return `⚠️ Sprint "${label}" not found; check Team Settings → Iterations.`;
      let type = null;
      if (/list\s+issues/i.test(T)) type = "Issue";
      if (/list\s+tasks/i.test(T)) type = "Task";
      const rows = await listItemsInIteration({ iterationPath: sprintPath, type });
      if (!rows.length) return `No ${type || "work items"} found in ${label}.`;
      const head = `🧾 ${type ? `${type}s` : "Work Items"} in ${label}`;
      return `${head}:<br>${rows.map((i) => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`;
    } catch (e) {
      return `⚠️ Unable to list: ${e?.message || "unexpected error"}`;
    }
  }

  // Describe <id|title>
  const descrRe = /^(?:what\s+(?:is|does)\s+the\s+)?(?:(?:description)|about)\s+(?:of|for)\s+(.+)$/i;
  if (descrRe.test(T) || /^description$/i.test(T)) {
    try {
      const q = /^description$/i.test(T) ? "" : T.replace(descrRe, "$1").trim();
      const wi = await getCanonicalWI(q || text);
      if (!wi) return `⚠️ Could not find that work item.`;
      const f = wi.fields || {};
      const desc = stripHtml(f["System.Description"] || f["Microsoft.VSTS.TCM.ReproSteps"] || "");
      return `<b>#${wi.id}: ${f["System.Title"]}</b><br>${desc || "(No description provided)"}`;
    } catch (e) {
      return `⚠️ Unable to fetch description: ${e?.message || "unexpected error"}`;
    }
  }

  // Child tasks of <id|title>
  const tasksOfRe = /^(?:what\s+is\s+the\s+child\s+task\s+of|(?:list|show)\s+(?:the\s+)?tasks?\s+(?:of|for))\s+(.+)$/i;
  if (tasksOfRe.test(T)) {
    try {
      const q = T.replace(tasksOfRe, "$1").trim();
      const wi = await getCanonicalWI(q);
      if (!wi) {
        if (AI_ENABLED) {
          const aiCtx = await buildAIContext();
          const tip = await queryWithAI(
            `User asked for child tasks of "${q}" but no parent matched. Give 3 bullets of next steps (try #ID, list sprint items, confirm exact title).`,
            aiCtx
          );
          return `⚠️ Could not find the parent work item.<br><br>🤖 <b>AI Assistant:</b><br><br>${tip}`;
        }
        return `⚠️ Could not find the parent work item.`;
      }
      const childIds = childIdsFromRelations(wi);
      if (!childIds.length) return `No child Tasks found for #${wi.id} ${wi.fields["System.Title"]}.`;

      const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
      const { default: axios } = await import("axios");
      const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${childIds.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
      const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64") };
      const { data } = await axios.get(url, { headers, timeout: 15000 });
      const tasks = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Task");
      if (!tasks.length) return `No child Tasks found for #${wi.id} ${wi.fields["System.Title"]}.`;
      const lines = tasks.map(w => `#${w.id} ${w.fields["System.Title"]} [${w.fields["System.State"]}]`);
      return `Child Tasks of #${wi.id} ${wi.fields["System.Title"]}:<br>${lines.join("<br>")}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Could not list child tasks: ${msg}`;
    }
  }

  // Linked bugs
  const linkedBugsRe = /^which\s+bugs?\s+(?:are\s+linked\s+to|link(?:ed)?\s+with)\s+(.+)$/i;
  if (linkedBugsRe.test(T)) {
    try {
      const q = T.replace(linkedBugsRe, "$1").trim();
      const wi = await getCanonicalWI(q);
      if (!wi) return `⚠️ Could not find that work item.`;
      const allIds = relatedIdsFromRelations(wi);
      if (!allIds.length) return `No linked Bugs found for #${wi.id}.`;
      const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
      const { default: axios } = await import("axios");
      const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${allIds.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
      const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64") };
      const { data } = await axios.get(url, { headers, timeout: 15000 });
      const bugs = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Bug");
      return bugs.length ? `Linked Bugs:<br>${bugs.map(b => `#${b.id} ${b.fields["System.Title"]} [${b.fields["System.State"]}]`).join("<br>")}` : `No linked Bugs found for #${wi.id}.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to fetch linked bugs: ${msg}`;
    }
  }

  // Issues without child tasks
  const noChildInSprintRe = /^list\s+all\s+issues?\s+that\s+don'?t\s+have\s+any\s+child\s+tasks?(?:\s+in\s+sprint\s+(.+))?$/i;
  if (noChildInSprintRe.test(T)) {
    try {
      const sprintLabel = T.replace(noChildInSprintRe, "$1").trim();
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      } else if (sprintCache.stories[0]?.path) {
        iterationPath = sprintCache.stories[0].path;
      } else {
        return `⚠️ No sprint context available. Try: "in sprint 2".`;
      }

      const issues = await listItemsInIteration({ iterationPath, type: "Issue" });
      if (!issues.length) return `No Issues found in that sprint.`;

      const { default: axios } = await import("axios");
      const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64") };
      const relUrls = issues.map(i => `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${i.id}?api-version=7.0&$expand=relations`);
      const relRes = await Promise.allSettled(relUrls.map(u => axios.get(u, { headers, timeout: 15000 })));
      const noTaskIssues = [];
      for (const rr of relRes) {
        if (rr.status !== "fulfilled") continue;
        const wi = rr.value.data;
        const kids = childIdsFromRelations(wi);
        if (!kids.length) noTaskIssues.push(`#${wi.id} ${wi.fields["System.Title"]}`);
      }
      return noTaskIssues.length ? `Issues without child Tasks:<br>${noTaskIssues.join("<br>")}` : `All Issues in that sprint have child Tasks.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to check: ${msg}`;
    }
  }

  // Unassigned in To Do
  const unassignedRe = /^\s*which\s+(items|issues|tasks|work\s*items)\s+are\s+unassigned\s+in\s+to\s*-?\s*do(?:\s+in\s+sprint\s+(.+?))?(?:\s|,|\.|!|$)/i;
  const unassignedMatch = T.match(unassignedRe);
  if (unassignedMatch) {
    try {
      const kindRaw = unassignedMatch[1].toLowerCase();
      const sprintLabel = unassignedMatch[2]?.trim();
      const type = kindRaw.includes("issue") ? "Issue" : kindRaw.includes("task") ? "Task" : null;
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      }
      const rows = await listUnassignedInToDo({ type, iterationPath });
      if (!rows?.length) {
        return sprintLabel
          ? `There are no unassigned ${type || "items"} in To Do for ${sprintLabel}.`
          : `There are no unassigned ${type || "items"} in To Do.`;
      }
      const heading = sprintLabel ? `Unassigned in <b>To Do</b> (Sprint: ${sprintLabel})` : `Unassigned in <b>To Do</b>`;
      return `${heading}:<br>${rows.map((r) => `#${r.id}: ${r.title} (${r.type})`).join("<br>")}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to check unassigned: ${msg}`;
    }
  }

  // Create/move
  const createInSprintIssue = T.match(/^create\s+issue\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintIssue) {
    try {
      const [, sprintLabel, title] = createInSprintIssue;
      const path = resolveSprintPath(sprintLabel);
      if (!path) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      const created = await createUserStory({ title, iterationPath: path });
      return `✅ Created Issue #${created.id} in ${sprintLabel}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to create Issue: ${msg}`;
    }
  }
  const createInSprintTask = T.match(/^create\s+task\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintTask) {
    try {
      const [, sprintLabel, title] = createInSprintTask;
      const path = resolveSprintPath(sprintLabel);
      if (!path) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      const created = await createTask({ title, iterationPath: path });
      return `✅ Created Task #${created.id} in ${sprintLabel}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to create Task: ${msg}`;
    }
  }

  const listMatch = T.match(/list\s+(issues|tasks|work items)/i);
  if (listMatch) {
    try {
      const typeMap = { issues: "Issue", tasks: "Task", "work items": "All" };
      const type = typeMap[listMatch[1].toLowerCase()];
      const items = await listWorkItems(type);
      return items.length
        ? `🧾 Latest ${type === "All" ? "Work Items" : type + "s"}:<br>${items.slice(0, 20).map((i) => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`
        : `No ${type === "All" ? "work items" : type + "s"} found.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to list latest: ${msg}`;
    }
  }

  const getMatch = T.match(/get\s+(\d+)|show\s+(\d+)|#(\d+)/i);
  if (getMatch) {
    try {
      const id = getMatch[1] || getMatch[2] || getMatch[3];
      const w = await getWorkItem(id);
      if (!w) return "⚠️ Work item not found.";
      const f = w.fields;
      return `<b>#${id}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}<br>State: ${f["System.State"]}<br>Assigned: ${f["System.AssignedTo"]?.displayName || "Unassigned"}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to fetch item: ${msg}`;
    }
  }

  const moveToSprint = T.match(/^\s*move\s+(\d+)\s+to\s+sprint\s+(.+?)\s*$/i);
  if (moveToSprint) {
    try {
      const [, id, label] = moveToSprint;
      const sprintPath = resolveSprintPath(label);
      if (!sprintPath) return `⚠️ Sprint "${label}" not found; check Team Settings → Iterations.`;
      await updateWorkItemIteration(id, sprintPath);
      return `✅ Moved #${id} to ${label} (Iteration Path applied).`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to move item: ${msg}`;
    }
  }

  const moveState = T.match(/^\s*move\s+(\d+)\s+to\s+(.+?)\s*$/i);
  if (moveState) {
    try {
      const [, id, raw] = moveState;
      const norm = raw.trim().replace(/["'“”]/g, "").toLowerCase();
      const stateMap = {
        todo: "To Do",
        "to do": "To Do",
        "to-do": "To Do",
        doing: "Doing",
        "in progress": "Doing",
        done: "Done",
        completed: "Done",
        complete: "Done",
      };
      const canonical = stateMap[norm] || stateMap[norm.replace(/\s+/g, " ")];
      if (!canonical) return `⚠️ Unknown state "${raw}". Try: To Do, Doing, Done.`;
      await updateWorkItemState(id, canonical);
      return `✅ Moved #${id} to ${canonical}.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to update state: ${msg}`;
    }
  }

  // Current/all sprints
  if (/current sprint|sprint stories|show sprint|show current sprint items/i.test(T)) {
    return getCurrentSprintStories();
  }
  if (/all sprints|sprint summary|sprint overview/i.test(T)) {
    return getAllSprintsSummary();
  }

  // AI narrative fallback — keep last
  const isNLQ = /^(what|how|show|tell|explain|who|when|where|which|why|can you|could you|summari[sz]e|list|find|recommend|prioriti[sz]e|first|next|order|sequence|analy[sz]e|assess|risks?|blockers?|bugs?|issues?|backlog|sprint|velocity|burndown|launch|rollout|release|country|market)/i.test(T);
  if (AI_ENABLED && isNLQ && T.length > 10 && !state.flow) {
    try {
      const aiCtx = await buildAIContext();
      const aiResponse = await queryWithAI(T, aiCtx);
      return `🤖 <b>AI Assistant:</b><br><br>${aiResponse}`;
    } catch {
      return "⚠️ AI is temporarily unavailable. Please try again.";
    }
  }

  return "💡 Try: list items in sprint 2, describe #28, or list tasks of <title>";
}

// Socket wiring
io.on("connection", (socket) => {
  const sessionId = uuidv4();
  console.log("🟢 User connected:", sessionId);

  socket.emit("bot_message", `Hello! I’m your Azure Boards Assistant.<br>Loading sprint data...`);

  setTimeout(() => {
    if (sprintCache.stories.length > 0) {
      socket.emit("bot_message", getAllSprintsSummary());
    } else {
      socket.emit("bot_message", "⚠️ Sprint data is still loading. Please wait...");
    }
    socket.emit("bot_message", "Type <b>help</b> to see what I can do!");
  }, 1500);

  socket.on("user_message", async (text) => {
    try {
      const reply = await handleMessage(sessionId, text);
      socket.emit("bot_message", reply);
    } catch (err) {
      console.error("handleMessage error:", err);
      socket.emit("bot_message", "⚠️ Sorry, something went wrong handling that request. Please try again.");
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", sessionId);
    delete conversationState[sessionId];
  });
});

// Startup
(async () => {
  console.log("🚀 Starting Azure Boards Assistant...");
  await loadSprintData();
  setInterval(async () => {
    console.log("🔄 Refreshing sprint data...");
    await loadSprintData();
  }, 15 * 60 * 1000);

  httpServer.listen(PORT, () => {
    console.log(`Server at http://localhost:${PORT} (AI: ${AI_ENABLED ? `ENABLED (${getModelName()})` : "DISABLED"})`);
  });
})();*/
// server.js — Azure Boards assistant (deterministic data + resilient AI fallback)

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

import {
  loadSprintData,
  getCurrentSprintStories,
  getAllSprintsSummary,
  sprintCache,
} from "./sprintDataLoader.js";

import {
  createUserStory,
  createTask,
  listWorkItems,
  getWorkItem,                
  updateWorkItemState,
  findWorkItemsByKeyword,    
  listUnassignedInToDo,
  updateWorkItemIteration,
  listItemsInIteration,       
} from "./workItemManager.js";

import { queryWithAI, getModelName } from "./Integration.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim());

httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 67000;
httpServer.requestTimeout = 0;

const io = new Server(httpServer, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT, OPENROUTER_API_KEY } = process.env;
if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  console.error("❌ Missing Azure DevOps config in .env (AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT)");
  process.exit(1);
}
const AI_ENABLED = !!OPENROUTER_API_KEY;
console.log(AI_ENABLED ? `✨ OpenRouter AI enabled (model: ${getModelName()})` : "ℹ️ AI disabled");

// ---------- Utilities ----------
function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function childIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .filter(r => r.rel && r.rel.toLowerCase().includes("hierarchy-forward"))
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

function relatedIdsFromRelations(wi) {
  const rels = wi?.relations || [];
  return rels
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
}

// Iteration Path resolver for “Sprint N”
function resolveSprintPath(userInput) {
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

// Robust title/ID resolution + shortlist to avoid dead ends
async function resolveTitleOrIdWithShortlist(queryText) {
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

async function getCanonicalWI(ref) {
  const { id } = await resolveTitleOrIdWithShortlist(ref);
  if (!id) return null;
  try {
    const wi = await getWorkItem(id);
    return wi || null;
  } catch {
    return null;
  }
}

// Compact AI context
async function buildAIContext() {
  const ctx = {
    now: new Date().toISOString(),
    totalSprintsCached: sprintCache.stories.length || 0,
    currentSprint: sprintCache.stories[0]?.sprintName || null,
    currentSprintItems: [],
    currentSprintStats: { total: 0, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 },
    lastTwoSprints: [],
  };

  const cur = sprintCache.stories[0] || null;
  if (cur) {
    const st = { total: cur.stories.length, todo: 0, doing: 0, done: 0, unassignedTodo: 0, remainingWork: 0, storyPoints: 0 };
    for (const s of cur.stories) {
      if (s.state === "To Do") st.todo++;
      if (s.state === "Doing") st.doing++;
      if (s.state === "Done") st.done++;
      if (s.state === "To Do" && (!s.assignedTo || s.assignedTo === "Unassigned")) st.unassignedTodo++;
      st.remainingWork += Number(s.remainingWork) || 0;
      st.storyPoints += Number(s.storyPoints) || 0;
    }
    ctx.currentSprintStats = st;
    ctx.currentSprintItems = cur.stories.slice(0, 8);
  }

  const buckets = (sprintCache.stories || []).slice(0, 2);
  for (const b of buckets) {
    const agg = { sprintName: b.sprintName, items: b.stories.length, todo: 0, doing: 0, done: 0 };
    for (const s of b.stories) {
      if (s.state === "To Do") agg.todo++;
      if (s.state === "Doing") agg.doing++;
      if (s.state === "Done") agg.done++;
    }
    ctx.lastTwoSprints.push(agg);
  }
  return ctx;
}

// ---------- Router ----------
const conversationState = {};

async function handleMessage(sessionId, text) {
  const state = conversationState[sessionId] || { flow: null, temp: {} };
  text = text.trim();
  const T = text.replace(/^[\s"'`“”‘’•\-–—]+/, "").replace(/[.!?]+$/, "").trim();

  // Help
  if (/^(hi|hello|hey|help)$/i.test(T)) {
    return [
      "👋 Hi — I'm your Azure DevOps Assistant!",
      "📊 Boards: current sprint, all sprints, open vs closed, list items in sprint N",
      "🔍 Items: describe #28, list tasks of #28, which bugs are linked to #28",
      "✏️ Create/Move: create issue/task in sprint N, move # to Doing, move # to sprint N",
      "💡 AI: what tasks should be completed first, when should we launch sprint 1 in other countries",
    ].join("<br>");
  }

  // Open vs closed (Basic)
  if (/open\s+vs\s+closed|total\s+number\s+of\s+open\s+vs\s+closed/i.test(T)) {
    const cur = sprintCache.stories[0] || null;
    if (!cur) return "⚠️ No sprint data loaded yet; please wait and try again.";
    const todo = cur.stories.filter(i => i.state === "To Do").length;
    const doing = cur.stories.filter(i => i.state === "Doing").length;
    const done = cur.stories.filter(i => i.state === "Done").length;
    const open = todo + doing;
    return `Open items: ${open} (To Do: ${todo} + Doing: ${doing})<br>Closed items: ${done}`;
  }

  // Show both issues and tasks in a sprint (one response)
const showBothInSprintRe =
  /^\s*(?:show|list|lists)\s+(?:the\s+)?(?:issues?\s+and\s+tasks?|tasks?\s+and\s+issues?)\s+(?:in|of)\s+sprint\s+(\d+)\s*\.?$/i;

const mBoth = T.match(showBothInSprintRe);
if (mBoth) {
  try {
    const sn = mBoth[1];
    const sprintPath = resolveSprintPath(`Sprint ${sn}`);
    if (!sprintPath) return `⚠️ Sprint "Sprint ${sn}" not found; check Team Settings → Iterations.`;
    const [issues, tasks] = await Promise.all([
      listItemsInIteration({ iterationPath: sprintPath, type: "Issue" }),
      listItemsInIteration({ iterationPath: sprintPath, type: "Task"  }),
    ]);
    const fmt = rows => rows.map(r => `#${r.id}: ${r.title} [${r.state}]`).join("<br>") || "(none)";
    return `🧾 Issues in Sprint ${sn}:<br>${fmt(issues)}<br><br>🧾 Tasks in Sprint ${sn}:<br>${fmt(tasks)}`;
  } catch (e) {
    const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
    return `⚠️ Unable to list issues and tasks: ${msg}`;
  }
}

// ================= Describe/Explain — AI first, deterministic fallback =================
// Triggers (both ID and Title):
// - what is #29 about
// - describe #29
// - explain #29
// - tell me about #29
// - what is <title> about
// - describe <title>
// - explain <title>
// - tell me about <title>
// - what is the description of <title|#id>
// - what does <title> do

const NL_DESCR_ID =
  /^(?:what\s+is\s+#?(\d+)\s+about|describe\s+#?(\d+)|explain\s+#?(\d+)|tell\s+me\s+about\s+#?(\d+)|what\s+is\s+the\s+description\s+of\s+#?(\d+))\b/i;

const NL_DESCR_TITLE =
  /^(?:what\s+is\s+(.+?)\s+about|describe\s+(.+)|explain\s+(.+)|tell\s+me\s+about\s+(.+)|what\s+does\s+(.+)\s+do|what\s+is\s+the\s+description\s+of\s+(.+))$/i;

if (NL_DESCR_ID.test(T) || NL_DESCR_TITLE.test(T) || /^(description|describe|explain|about)\b/i.test(T)) {
  try {
    // Resolve target text (ID or Title)
    let q = null;

    const mId = T.match(NL_DESCR_ID);
    if (mId) {
      const idStr = [1,2,3,4,5].map(i => mId[i]).find(Boolean);
      q = `#${idStr}`;
    } else {
      const mTitle = T.match(NL_DESCR_TITLE);
      if (mTitle) {
        const t = [1,2,3,4,5,6].map(i => mTitle[i]).find(Boolean);
        q = t ? t.trim() : text;
      } else {
        // If user just typed "describe"/"explain"/"about"/"description" with no object
        q = text;
      }
    }

    const wi = await getCanonicalWI(q);
    if (!wi) return `⚠️ Could not find that work item.`;

    const f = wi.fields || {};
    const title = f["System.Title"] || "(Untitled)";
    const type = f["System.WorkItemType"] || "Work Item";
    const state = f["System.State"] || "Unknown";
    const assigned = f["System.AssignedTo"]?.displayName || "Unassigned";

    const rawHtml =
      f["System.Description"] ||
      f["Microsoft.VSTS.TCM.ReproSteps"] ||
      "";

    const header = `<b>#${wi.id}: ${title}</b><br>Type: ${type}<br>State: ${state}<br>Assigned: ${assigned}`;

    // If there is no description at all, return deterministic, no AI call needed
    if (!String(rawHtml).trim()) {
      return `${header}<br><br>(No description provided)`;
    }

// 1) Try AI summary first (plain text, concise), but never return on failure
let aiOut = "";
if (AI_ENABLED) {
  try {
    const aiCtx = await buildAIContext();
    const prompt = [
      "Summarize the following work item description in 4–6 plain-text bullets (no JSON).",
      "Cover purpose, main steps, inputs/outputs, and notable risks. Be concise.",
      "",
      `Work Item: #${wi.id} — ${title} [${type}|${state}]`,
      `Assigned: ${assigned}`,
      "",
      "DESCRIPTION:",
      String(rawHtml).slice(0, 4000)
    ].join("\n");

    const ai = await queryWithAI(prompt, aiCtx);
    if (ai && ai.trim() && !/^⚠️/.test(ai.trim())) {
      aiOut = ai.trim();
    }
  } catch {
    // ignore and fall through
  }
}

// If AI produced something, use it. Otherwise deterministic fallback.
if (aiOut) {
  return `${header}<br><br>${aiOut}`;
}

// 2) Deterministic fallback: print description as-is (HTML preserved)
return `${header}<br><br>${rawHtml}`;


   
    /*
    const clean = stripHtml(rawHtml);
    const maxBullets = 6;
    const lines = clean.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let bullets = lines
      .filter(s => /^[-*•]\s+/.test(s) || /^\d+[\.\)]\s+/.test(s))
      .map(s => s.replace(/^([-*•]|\d+[\.\)])\s+/, "").trim());
    if (bullets.length < 2) {
      const paras = clean.split(/\r?\n\s*\r?\n/).map(s => s.trim()).filter(Boolean);
      bullets = paras.map(p => p.length > 220 ? `${p.slice(0, 220)}…` : p);
    }
    let body;
    if (bullets.length) {
      const clipped = bullets.slice(0, maxBullets);
      body = clipped.map(b => `- ${b}`).join("<br>");
      if (bullets.length > maxBullets) body += `<br>…`;
    } else {
      const maxChars = 1200;
      body = clean ? (clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean) : "(No description provided)";
    }
    return `${header}<br><br>${body}`;
    */
  } catch (e) {
    const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
    return `⚠️ Unable to fetch description: ${msg}`;
  }
}


  // Sprint tasks routes
  const listTasksOfSprintRe = /^\s*list\s+the\s+tasks\s+of\s+sprint\s+(\d+)\s*$/i;
  const listTasksInSprintRe = /^\s*list\s+tasks\s+in\s+sprint\s+(\d+)\s*$/i;
  const mSprintTasks = T.match(listTasksOfSprintRe) || T.match(listTasksInSprintRe);
  if (mSprintTasks) {
    try {
      const sn = mSprintTasks[1];
      const sprintPath = resolveSprintPath(`Sprint ${sn}`);
      if (!sprintPath) return `⚠️ Sprint "Sprint ${sn}" not found; check Team Settings → Iterations.`;
      const rows = await listItemsInIteration({ iterationPath: sprintPath, type: "Task" });
      return rows.length
        ? `🧾 Tasks in Sprint ${sn}:<br>${rows.map(r => `#${r.id}: ${r.title} [${r.state}]`).join("<br>")}`
        : `No Tasks found in Sprint ${sn}.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to list tasks in Sprint ${mSprintTasks[1]}: ${msg}`;
    }
  }



  // Child tasks of <id|title> with sprint guard and shortlist fallback
  const tasksOfRe = /^(?:what\s+is\s+the\s+child\s+task\s+of|(?:list|show)\s+(?:the\s+)?tasks?\s+(?:of|for))\s+(.+)$/i;
  if (tasksOfRe.test(T)) {
    try {
      const qRaw = T.replace(tasksOfRe, "$1").trim();

      const sprintNum = (qRaw.match(/sprint\s+(\d+)/i) || [null, null])[1];
      if (sprintNum) {
        const sprintPath = resolveSprintPath(`Sprint ${sprintNum}`);
        if (!sprintPath) return `⚠️ Sprint "Sprint ${sprintNum}" not found; check Team Settings → Iterations.`;
        const rows = await listItemsInIteration({ iterationPath: sprintPath, type: "Task" });
        return rows.length
          ? `🧾 Tasks in Sprint ${sprintNum}:<br>${rows.map(r => `#${r.id}: ${r.title} [${r.state}]`).join("<br>")}`
          : `No Tasks found in Sprint ${sprintNum}.`;
      }

      const { id: parentId, shortlist } = await resolveTitleOrIdWithShortlist(qRaw);
      if (!parentId) {
        if (shortlist && shortlist.length) {
          const tips = shortlist.map(s => `#${s.id} — ${s.title}`).join("<br>");
          return `⚠️ Could not find the parent work item.<br>Did you mean:<br>${tips}<br><br>Tip: try “list tasks of #<id>”.`;
        }
        return `⚠️ Could not find the parent work item. Try “list items in sprint 2” and copy the exact title.`;
      }

      const parent = await getWorkItem(parentId);
      const childIds = childIdsFromRelations(parent);
      if (!childIds.length) return `No child Tasks found for #${parent.id} ${parent.fields["System.Title"]}.`;

      const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
      const { default: axios } = await import("axios");
      const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${childIds.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
      const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64") };
      const { data } = await axios.get(url, { headers, timeout: 15000 });
      const tasks = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Task");

      if (!tasks.length) return `No child Tasks found for #${parent.id} ${parent.fields["System.Title"]}.`;

      const lines = tasks.map(w => `#${w.id} ${w.fields["System.Title"]} [${w.fields["System.State"]}]`);
      return `Child Tasks of #${parent.id} ${parent.fields["System.Title"]}:<br>${lines.join("<br>")}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Could not list child tasks: ${msg}`;
    }
  }

  // Linked bugs
  const linkedBugsRe = /^which\s+bugs?\s+(?:are\s+linked\s+to|link(?:ed)?\s+with)\s+(.+)$/i;
  if (linkedBugsRe.test(T)) {
    try {
      const q = T.replace(linkedBugsRe, "$1").trim();
      const wi = await getCanonicalWI(q);
      if (!wi) return `⚠️ Could not find that work item.`;
      const allIds = relatedIdsFromRelations(wi);
      if (!allIds.length) return `No linked Bugs found for #${wi.id}.`;
      const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
      const { default: axios } = await import("axios");
      const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${allIds.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
      const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64") };
      const { data } = await axios.get(url, { headers, timeout: 15000 });
      const bugs = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Bug");
      return bugs.length ? `Linked Bugs:<br>${bugs.map(b => `#${b.id} ${b.fields["System.Title"]} [${b.fields["System.State"]}]`).join("<br>")}` : `No linked Bugs found for #${wi.id}.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to fetch linked bugs: ${msg}`;
    }
  }

  // Issues without child tasks
  const noChildInSprintRe = /^list\s+all\s+issues?\s+that\s+don'?t\s+have\s+any\s+child\s+tasks?(?:\s+in\s+sprint\s+(.+))?$/i;
  if (noChildInSprintRe.test(T)) {
    try {
      const sprintLabel = T.replace(noChildInSprintRe, "$1").trim();
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      } else if (sprintCache.stories[0]?.path) {
        iterationPath = sprintCache.stories[0].path;
      } else {
        return `⚠️ No sprint context available. Try: "in sprint 2".`;
      }

      const issues = await listItemsInIteration({ iterationPath, type: "Issue" });
      if (!issues.length) return `No Issues found in that sprint.`;

      const { default: axios } = await import("axios");
      const headers = { Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64") };
      const relUrls = issues.map(i => `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${i.id}?api-version=7.0&$expand=relations`);
      const relRes = await Promise.allSettled(relUrls.map(u => axios.get(u, { headers, timeout: 15000 })));
      const noTaskIssues = [];
      for (const rr of relRes) {
        if (rr.status !== "fulfilled") continue;
        const wi = rr.value.data;
        const kids = childIdsFromRelations(wi);
        if (!kids.length) noTaskIssues.push(`#${wi.id} ${wi.fields["System.Title"]}`);
      }
      return noTaskIssues.length ? `Issues without child Tasks:<br>${noTaskIssues.join("<br>")}` : `All Issues in that sprint have child Tasks.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to check: ${msg}`;
    }
  }

  // Unassigned in To Do (optional sprint)
  const unassignedRe = /^\s*which\s+(items|issues|tasks|work\s*items)\s+are\s+unassigned\s+in\s+to\s*-?\s*do(?:\s+in\s+sprint\s+(.+?))?(?:\s|,|\.|!|$)/i;
  const unassignedMatch = T.match(unassignedRe);
  if (unassignedMatch) {
    try {
      const kindRaw = unassignedMatch[1].toLowerCase();
      const sprintLabel = unassignedMatch[2]?.trim();
      const type = kindRaw.includes("issue") ? "Issue" : kindRaw.includes("task") ? "Task" : null;
      let iterationPath = null;
      if (sprintLabel) {
        iterationPath = resolveSprintPath(sprintLabel);
        if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      }
      const rows = await listUnassignedInToDo({ type, iterationPath });
      if (!rows?.length) {
        return sprintLabel
          ? `There are no unassigned ${type || "items"} in To Do for ${sprintLabel}.`
          : `There are no unassigned ${type || "items"} in To Do.`;
      }
      const heading = sprintLabel ? `Unassigned in <b>To Do</b> (Sprint: ${sprintLabel})` : `Unassigned in <b>To Do</b>`;
      return `${heading}:<br>${rows.map((r) => `#${r.id}: ${r.title} (${r.type})`).join("<br>")}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to check unassigned: ${msg}`;
    }
  }

  // Create / Move
  const createInSprintIssue = T.match(/^create\s+issue\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintIssue) {
    try {
      const [, sprintLabel, title] = createInSprintIssue;
      const path = resolveSprintPath(sprintLabel);
      if (!path) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      const created = await createUserStory({ title, iterationPath: path });
      return `✅ Created Issue #${created.id} in ${sprintLabel}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to create Issue: ${msg}`;
    }
  }

  const createInSprintTask = T.match(/^create\s+task\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
  if (createInSprintTask) {
    try {
      const [, sprintLabel, title] = createInSprintTask;
      const path = resolveSprintPath(sprintLabel);
      if (!path) return `⚠️ Sprint "${sprintLabel}" not found; check Team Settings → Iterations.`;
      const created = await createTask({ title, iterationPath: path });
      return `✅ Created Task #${created.id} in ${sprintLabel}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to create Task: ${msg}`;
    }
  }



  const listMatch = T.match(/list\s+(issues|tasks|work items)/i);
  if (listMatch) {
    try {
      const typeMap = { issues: "Issue", tasks: "Task", "work items": "All" };
      const type = typeMap[listMatch[1].toLowerCase()];
      const items = await listWorkItems(type);
      return items.length
        ? `🧾 Latest ${type === "All" ? "Work Items" : type + "s"}:<br>${items.slice(0, 20).map((i) => `#${i.id}: ${i.title} [${i.state}]`).join("<br>")}`
        : `No ${type === "All" ? "work items" : type + "s"} found.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to list latest: ${msg}`;
    }
  }



  const getMatch = T.match(/get\s+(\d+)|show\s+(\d+)|#(\d+)/i);
  if (getMatch) {
    try {
      const id = getMatch[1] || getMatch[2] || getMatch[3];
      const w = await getWorkItem(id);
      if (!w) return "⚠️ Work item not found.";
      const f = w.fields;
      return `<b>#${id}: ${f["System.Title"]}</b><br>Type: ${f["System.WorkItemType"]}<br>State: ${f["System.State"]}<br>Assigned: ${f["System.AssignedTo"]?.displayName || "Unassigned"}`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Unable to fetch item: ${msg}`;
    }
  }

  const moveToSprint = T.match(/^\s*move\s+(\d+)\s+to\s+sprint\s+(.+?)\s*$/i);
  if (moveToSprint) {
    try {
      const [, id, label] = moveToSprint;
      const sprintPath = resolveSprintPath(label);
      if (!sprintPath) return `⚠️ Sprint "${label}" not found; check Team Settings → Iterations.`;
      await updateWorkItemIteration(id, sprintPath);
      return `✅ Moved #${id} to ${label} (Iteration Path applied).`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to move item: ${msg}`;
    }
  }

  const moveState = T.match(/^\s*move\s+(\d+)\s+to\s+(.+?)\s*$/i);
  if (moveState) {
    try {
      const [, id, raw] = moveState;
      const norm = raw.trim().replace(/["'“”]/g, "").toLowerCase();
      const stateMap = {
        todo: "To Do",
        "to do": "To Do",
        "to-do": "To Do",
        doing: "Doing",
        "in progress": "Doing",
        done: "Done",
        completed: "Done",
        complete: "Done",
      };
      const canonical = stateMap[norm] || stateMap[norm.replace(/\s+/g, " ")];
      if (!canonical) return `⚠️ Unknown state "${raw}". Try: To Do, Doing, Done.`;
      await updateWorkItemState(id, canonical);
      return `✅ Moved #${id} to ${canonical}.`;
    } catch (e) {
      const msg = /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(String(e?.code)) ? "Azure Boards is unreachable (timeout)" : (e?.message || "unexpected error");
      return `⚠️ Failed to update state: ${msg}`;
    }
  }

  // Current/all sprints summaries
  if (/current sprint|sprint stories|show sprint|show current sprint items/i.test(T)) {
    return getCurrentSprintStories();
  }
  if (/all sprints|sprint summary|sprint overview/i.test(T)) {
    return getAllSprintsSummary();
  }

  // AI fallback — keep last and broad
  const isNLQ = /^(what|how|show|tell|explain|who|when|where|which|why|can you|could you|summari[sz]e|list|find|recommend|prioriti[sz]e|first|next|order|sequence|analy[sz]e|assess|risks?|blockers?|bugs?|issues?|backlog|sprint|velocity|burndown|launch|rollout|release|country|market)/i.test(T);
  if (AI_ENABLED && isNLQ && T.length > 10 && !state.flow) {
    try {
      const aiCtx = await buildAIContext();
      const aiResponse = await queryWithAI(T, aiCtx);
      return `🤖 <b>AI Assistant:</b><br><br>${aiResponse || "⚠️ AI returned no content. Please try again."}`;
    } catch {
      return "⚠️ AI is temporarily unavailable. Please try again.";
    }
  }

  return "💡 Try: list items in sprint 2, describe #28, or list tasks of <title>";
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  const sessionId = uuidv4();
  console.log("🟢 User connected:", sessionId);

  socket.emit("bot_message", `Hello! I’m your Azure Boards Assistant.<br>Loading sprint data...`);

  setTimeout(() => {
    if (sprintCache.stories.length > 0) {
      socket.emit("bot_message", getAllSprintsSummary());
    } else {
      socket.emit("bot_message", "⚠️ Sprint data is still loading. Please wait...");
    }
    socket.emit("bot_message", "Type <b>help</b> to see what I can do!");
  }, 1500);

  socket.on("user_message", async (text) => {
    try {
      const reply = await handleMessage(sessionId, text);
      socket.emit("bot_message", reply);
    } catch (err) {
      console.error("handleMessage error:", err);
      socket.emit("bot_message", "⚠️ Sorry, something went wrong handling that request. Please try again.");
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", sessionId);
    delete conversationState[sessionId];
  });
});

// ---------- Startup ----------
(async () => {
  console.log("🚀 Starting Azure Boards Assistant...");
  await loadSprintData();
  setInterval(async () => {
    console.log("🔄 Refreshing sprint data...");
    await loadSprintData();
  }, 15 * 60 * 1000);

  httpServer.listen(PORT, () => {
    console.log(`Server at http://localhost:${PORT} (AI: ${AI_ENABLED ? `ENABLED (${getModelName()})` : "DISABLED"})`);
  });
})();
