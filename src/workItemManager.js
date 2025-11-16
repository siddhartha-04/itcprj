// workItemManager.js
/*import axios from "axios";

const API_VERSION = "7.0";

function patchHeaders() {
  return {
    Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"),
    "Content-Type": "application/json-patch+json",
  };
}
function jsonHeaders() {
  return {
    Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"),
    "Content-Type": "application/json",
  };
}

async function getProjectWITs() {
  const url = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/workitemtypes?api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return (data.value || []).map(v => v.name);
}

function resolveStoryLike(available) {
  if (available.includes("User Story")) return { type: "User Story", estimateField: "Microsoft.VSTS.Scheduling.StoryPoints", supportsAC: true };
  if (available.includes("Product Backlog Item")) return { type: "Product Backlog Item", estimateField: "Microsoft.VSTS.Scheduling.Effort", supportsAC: true };
  if (available.includes("Requirement")) return { type: "Requirement", estimateField: "Microsoft.VSTS.Scheduling.Effort", supportsAC: true };
  if (available.includes("Issue")) return { type: "Issue", estimateField: null, supportsAC: false };
  return null;
}

export async function createUserStory({ title, description = "", acceptanceCriteria = "", storyPoints = 0, assignedTo = "", iterationPath = null }) {
  const available = await getProjectWITs();
  const resolved = resolveStoryLike(available);
  if (!resolved) throw new Error(`No story-like type; project supports: ${available.join(", ")}`);

  const url = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/workitems/$${resolved.type}?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.Title", value: title }];

  if (description) ops.push({ op: "add", path: "/fields/System.Description", value: description });
  if (resolved.supportsAC && acceptanceCriteria) {
    ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: acceptanceCriteria });
  }
  if (resolved.estimateField && typeof storyPoints === "number" && storyPoints > 0) {
    ops.push({ op: "add", path: `/fields/${resolved.estimateField}`, value: storyPoints });
  }
  if (assignedTo) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: assignedTo });
  if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });

  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

export async function createTask({ title, description = "", assignedTo = "", remainingWork = null, parentId = null, iterationPath = null }) {
  const url = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/workitems/$Task?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.Title", value: title }];

  if (description) ops.push({ op: "add", path: "/fields/System.Description", value: description });
  if (assignedTo) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: assignedTo });
  if (typeof remainingWork === "number") ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: remainingWork });
  if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
  if (parentId) {
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${process.env.AZURE_ORG_URL}/_apis/wit/workItems/${parentId}` },
    });
  }

  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

export async function listWorkItems(type = "All") {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const base = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.TeamProject] = @project
    ORDER BY [System.ChangedDate] DESC
  `;
  const typed = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${type}'
    ORDER BY [System.ChangedDate] DESC
  `;
  const wiql = { query: type === "All" ? base : typed };
  const { data: idsRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (idsRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];

  const fields = [
    "System.Id","System.Title","System.WorkItemType","System.State",
    "System.AssignedTo","System.IterationPath","Microsoft.VSTS.Scheduling.RemainingWork"
  ];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });

  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    remainingWork: w.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? null,
    iterationPath: w.fields["System.IterationPath"] ?? null,
  }));
}

export async function getWorkItem(id) {
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return data;
}

// WIQL keyword search (title/description)
export async function findWorkItemsByKeyword(keyword) {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const safe = String(keyword || "").replace(/'/g, "''");
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND (
          [System.Title] CONTAINS '${safe}'
          OR [System.Description] CONTAINS '${safe}'
        )
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const { data: wiqlRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (wiqlRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];

  const fields = [
    "System.Id","System.Title","System.WorkItemType","System.State",
    "System.AssignedTo","System.IterationPath",
    "Microsoft.VSTS.Scheduling.RemainingWork","Microsoft.VSTS.Scheduling.StoryPoints"
  ];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });

  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    remainingWork: w.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? null,
    storyPoints: w.fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? null,
    iterationPath: w.fields["System.IterationPath"] ?? null,
  }));
}

// NEW: list items in a sprint (Iteration Path) with optional type filter
export async function listItemsInIteration({ iterationPath, type = null }) {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const escaped = String(iterationPath || "").replace(/'/g, "''");
  const typeFilter = type ? `AND [System.WorkItemType] = '${type}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.IterationPath] UNDER '${escaped}'
        ${typeFilter}
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const { data: idsRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (idsRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];

  const fields = ["System.Id","System.Title","System.WorkItemType","System.State","System.IterationPath"];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });
  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    iterationPath: w.fields["System.IterationPath"] || null,
  }));
}

// NEW: helper to check if an IterationPath is under a sprint node (matches UNDER semantics)
export function isUnderIterationPath(itemPath, sprintPath) {
  if (!itemPath || !sprintPath) return false;
  const a = itemPath.toLowerCase();
  const b = sprintPath.toLowerCase();
  return a === b || a.startsWith(b + "\\");
}

// Deterministic “Unassigned in To Do”
export async function listUnassignedInToDo({ type = null, iterationPath = null }) {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const typeFilter = type ? `AND [System.WorkItemType] = '${type}'` : "";
  const iterFilter = iterationPath ? `AND [System.IterationPath] UNDER '${String(iterationPath).replace(/'/g, "''")}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.State] = 'To Do'
        AND ([System.AssignedTo] = '' OR [System.AssignedTo] = NULL)
        ${typeFilter}
        ${iterFilter}
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const { data: idsRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (idsRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.WorkItemType","System.State","System.IterationPath"];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });
  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    iterationPath: w.fields["System.IterationPath"] || null,
  }));
}

const BASIC_STATE_MAP = {
  Epic: ["To Do", "Doing", "Done"],
  Issue: ["To Do", "Doing", "Done"],
  Task: ["To Do", "Doing", "Done"],
};

async function getWorkItemType(id) {
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return data.fields["System.WorkItemType"];
}

export async function updateWorkItemState(id, newState) {
  const type = await getWorkItemType(id);
  const allowed = BASIC_STATE_MAP[type] || [];
  if (!allowed.includes(newState)) {
    throw new Error(`Invalid state for ${type}: "${newState}". Allowed: ${allowed.join(", ")}`);
  }
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.State", value: newState }];
  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

export async function updateWorkItemIteration(id, iterationPath) {
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.IterationPath", value: iterationPath }];
  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}*/
// workItemManager.js
/*import axios from "axios";

const API_VERSION = "7.0";

function patchHeaders() {
  return {
    Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"),
    "Content-Type": "application/json-patch+json",
  };
}
function jsonHeaders() {
  return {
    Authorization: "Basic " + Buffer.from(":" + process.env.AZURE_PAT).toString("base64"),
    "Content-Type": "application/json",
  };
}

// Discover supported work item types
async function getProjectWITs() {
  const url = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/workitemtypes?api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return (data.value || []).map(v => v.name);
}

function resolveStoryLike(available) {
  if (available.includes("User Story")) return { type: "User Story", estimateField: "Microsoft.VSTS.Scheduling.StoryPoints", supportsAC: true };
  if (available.includes("Product Backlog Item")) return { type: "Product Backlog Item", estimateField: "Microsoft.VSTS.Scheduling.Effort", supportsAC: true };
  if (available.includes("Requirement")) return { type: "Requirement", estimateField: "Microsoft.VSTS.Scheduling.Effort", supportsAC: true };
  if (available.includes("Issue")) return { type: "Issue", estimateField: null, supportsAC: false };
  return null;
}

export async function createUserStory({ title, description = "", acceptanceCriteria = "", storyPoints = 0, assignedTo = "", iterationPath = null }) {
  const available = await getProjectWITs();
  const resolved = resolveStoryLike(available);
  if (!resolved) throw new Error(`No story-like type; project supports: ${available.join(", ")}`);

  const url = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/workitems/$${resolved.type}?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.Title", value: title }];

  if (description) ops.push({ op: "add", path: "/fields/System.Description", value: description });
  if (resolved.supportsAC && acceptanceCriteria) {
    ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: acceptanceCriteria });
  }
  if (resolved.estimateField && typeof storyPoints === "number" && storyPoints > 0) {
    ops.push({ op: "add", path: `/fields/${resolved.estimateField}`, value: storyPoints });
  }
  if (assignedTo) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: assignedTo });
  if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });

  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

export async function createTask({ title, description = "", assignedTo = "", remainingWork = null, parentId = null, iterationPath = null }) {
  const url = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/workitems/$Task?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.Title", value: title }];

  if (description) ops.push({ op: "add", path: "/fields/System.Description", value: description });
  if (assignedTo) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: assignedTo });
  if (typeof remainingWork === "number") ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: remainingWork });
  if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
  if (parentId) {
    // Link Task to parent (Hierarchy-Reverse on child)
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${process.env.AZURE_ORG_URL}/_apis/wit/workItems/${parentId}` },
    });
  }

  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

// List recent items (optional type)
export async function listWorkItems(type = "All") {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const base = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.TeamProject] = @project
    ORDER BY [System.ChangedDate] DESC
  `;
  const typed = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${type}'
    ORDER BY [System.ChangedDate] DESC
  `;
  const wiql = { query: type === "All" ? base : typed };
  const { data: idsRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (idsRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];

  const fields = [
    "System.Id","System.Title","System.WorkItemType","System.State",
    "System.AssignedTo","System.IterationPath","Microsoft.VSTS.Scheduling.RemainingWork"
  ];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });

  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    remainingWork: w.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? null,
    iterationPath: w.fields["System.IterationPath"] ?? null,
  }));
}

// IMPORTANT: $expand=relations so server can read children/linked items
export async function getWorkItem(id) {
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}&$expand=relations`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return data;
}

// Keyword search (title/description)
export async function findWorkItemsByKeyword(keyword) {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const safe = String(keyword || "").replace(/'/g, "''");
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND (
          [System.Title] CONTAINS '${safe}'
          OR [System.Description] CONTAINS '${safe}'
        )
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const { data: wiqlRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (wiqlRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];

  const fields = [
    "System.Id","System.Title","System.WorkItemType","System.State",
    "System.AssignedTo","System.IterationPath",
    "Microsoft.VSTS.Scheduling.RemainingWork","Microsoft.VSTS.Scheduling.StoryPoints"
  ];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });

  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    remainingWork: w.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? null,
    storyPoints: w.fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? null,
    iterationPath: w.fields["System.IterationPath"] ?? null,
  }));
}

// Iteration Path UNDER semantics for sprint listings
export async function listItemsInIteration({ iterationPath, type = null }) {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const escaped = String(iterationPath || "").replace(/'/g, "''");
  const typeFilter = type ? `AND [System.WorkItemType] = '${type}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.IterationPath] UNDER '${escaped}'
        ${typeFilter}
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const { data: idsRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (idsRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];

  const fields = ["System.Id","System.Title","System.WorkItemType","System.State","System.IterationPath"];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });
  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    iterationPath: w.fields["System.IterationPath"] || null,
  }));
}

// UNDER helper
export function isUnderIterationPath(itemPath, sprintPath) {
  if (!itemPath || !sprintPath) return false;
  const a = itemPath.toLowerCase();
  const b = sprintPath.toLowerCase();
  return a === b || a.startsWith(b + "\\");
}

// Unassigned “To Do” (global or sprint-scoped)
export async function listUnassignedInToDo({ type = null, iterationPath = null }) {
  const wiqlUrl = `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const typeFilter = type ? `AND [System.WorkItemType] = '${type}'` : "";
  const iterFilter = iterationPath ? `AND [System.IterationPath] UNDER '${String(iterationPath).replace(/'/g, "''")}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.State] = 'To Do'
        AND ([System.AssignedTo] = '' OR [System.AssignedTo] = NULL)
        ${typeFilter}
        ${iterFilter}
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const { data: idsRes } = await axios.post(wiqlUrl, wiql, { headers: jsonHeaders() });
  const ids = (idsRes.workItems || []).map(w => w.id);
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.WorkItemType","System.State","System.IterationPath"];
  const batchUrl = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(batchUrl, { headers: jsonHeaders() });
  return (data.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    type: w.fields["System.WorkItemType"],
    state: w.fields["System.State"],
    iterationPath: w.fields["System.IterationPath"] || null,
  }));
}

// Basic process state map
const BASIC_STATE_MAP = {
  Epic: ["To Do", "Doing", "Done"],
  Issue: ["To Do", "Doing", "Done"],
  Task: ["To Do", "Doing", "Done"],
};

async function getWorkItemType(id) {
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return data.fields["System.WorkItemType"];
}

export async function updateWorkItemState(id, newState) {
  const type = await getWorkItemType(id);
  const allowed = BASIC_STATE_MAP[type] || [];
  if (!allowed.includes(newState)) {
    throw new Error(`Invalid state for ${type}: "${newState}". Allowed: ${allowed.join(", ")}`);
  }
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.State", value: newState }];
  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

export async function updateWorkItemIteration(id, iterationPath) {
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const ops = [{ op: "add", path: "/fields/System.IterationPath", value: iterationPath }];
  const { data } = await axios.patch(url, ops, { headers: patchHeaders() });
  return data;
}

// Optional helpers used by server NLQ routes (children / linked)
export async function getChildrenTasks(id) {
  const wi = await getWorkItem(id); // $expand=relations
  const rels = wi?.relations || [];
  const childIds = rels
    .filter(r => r.rel && r.rel.toLowerCase().includes("hierarchy-forward"))
    .map(r => {
      const m = (r.url || "").match(/\/workitems\/(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean);
  if (!childIds.length) return [];
  const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${childIds.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Task").map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    state: w.fields["System.State"],
  }));
}

export async function getLinkedBugs(id) {
  const wi = await getWorkItem(id);
  const rels = wi?.relations || [];
  const ids = [];
  for (const r of rels) {
    const m = (r.url || "").match(/\/workitems\/(\d+)/i);
    if (m) ids.push(parseInt(m[1], 10));
  }
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.WorkItemType","System.State"];
  const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=${API_VERSION}`;
  const { data } = await axios.get(url, { headers: jsonHeaders() });
  return (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Bug").map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    state: w.fields["System.State"],
  }));
}*/
// workItemManager.js — Azure Boards WIQL/REST utilities with retries/timeouts

import axios from "axios";

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT } = process.env;

if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  throw new Error("Missing AZURE_ORG_URL / AZURE_PROJECT / AZURE_PAT");
}

const baseAuthHeaders = {
  Authorization: "Basic " + Buffer.from(":" + AZURE_PAT).toString("base64"),
};

// Small helper with retries/backoff for transient network errors
async function adoRequest(method, url, { data, headers = {}, timeout = 15000, retries = 2, backoffMs = 1200 } = {}) {
  const merged = { ...baseAuthHeaders, ...headers };
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      const res = await axios.request({ method, url, data, headers: merged, timeout });
      return res.data;
    } catch (e) {
      lastErr = e;
      const code = e?.code || e?.response?.status;
      const transient = code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN" || code === 502 || code === 503 || code === 504;
      if (!transient || attempt === retries) break;
      const wait = Math.floor(backoffMs * Math.pow(2, attempt) * (1 + 0.2 * Math.random()));
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }
  throw lastErr;
}

// Single work item with relations
export async function getWorkItem(id) {
  const primary = `${AZURE_ORG_URL}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`;
  try {
    return await adoRequest("GET", primary);
  } catch {
    // fallback to 7.0 if needed
    const fallback = `${AZURE_ORG_URL}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`;
    return await adoRequest("GET", fallback);
  }
}

// List latest by type
export async function listWorkItems(type = "All") {
  const typeClause = type !== "All" ? `AND [System.WorkItemType] = '${type}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        ${typeClause}
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const wiqlUrl = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/wiql?api-version=7.1`;
  const wi = await adoRequest("POST", wiqlUrl, { data: wiql, headers: { "Content-Type": "application/json" } });
  const ids = (wi.workItems || []).slice(0, 50).map(w => w.id);
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.State","System.WorkItemType","System.AssignedTo","System.IterationPath"];
  const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
  const details = await adoRequest("GET", detailsUrl);
  return (details.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    state: w.fields["System.State"],
    type: w.fields["System.WorkItemType"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    iterationPath: w.fields["System.IterationPath"] || "",
  }));
}

// Sprint-scoped list via UNDER
export async function listItemsInIteration({ iterationPath, type = null }) {
  if (!iterationPath) return [];
  const typeClause = type ? `AND [System.WorkItemType] = '${type}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.IterationPath] UNDER '${iterationPath.replace(/'/g, "''")}'
        ${typeClause}
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const wiqlUrl = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/wiql?api-version=7.1`;
  const wi = await adoRequest("POST", wiqlUrl, { data: wiql, headers: { "Content-Type": "application/json" } });
  const ids = (wi.workItems || []).map(w => w.id);
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.State","System.WorkItemType","System.AssignedTo","System.IterationPath"];
  const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
  const details = await adoRequest("GET", detailsUrl);
  return (details.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    state: w.fields["System.State"],
    type: w.fields["System.WorkItemType"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    iterationPath: w.fields["System.IterationPath"] || "",
  }));
}

// Move iteration
export async function updateWorkItemIteration(id, iterationPath) {
  const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/workitems/${id}?api-version=7.1`;
  const patch = [{ op: "add", path: "/fields/System.IterationPath", value: iterationPath }];
  const headers = { "Content-Type": "application/json-patch+json" };
  return await adoRequest("PATCH", url, { data: patch, headers });
}

// Move state (Basic)
export async function updateWorkItemState(id, state) {
  const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/workitems/${id}?api-version=7.1`;
  const patch = [{ op: "add", path: "/fields/System.State", value: state }];
  const headers = { "Content-Type": "application/json-patch+json" };
  return await adoRequest("PATCH", url, { data: patch, headers });
}

// Unassigned “To Do”
export async function listUnassignedInToDo({ type = null, iterationPath = null }) {
  const typeClause = type ? `AND [System.WorkItemType] = '${type}'` : "";
  const iterClause = iterationPath ? `AND [System.IterationPath] UNDER '${iterationPath.replace(/'/g,"''")}'` : "";
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        ${iterClause}
        ${typeClause}
        AND [System.State] = 'To Do'
        AND [System.AssignedTo] = ''
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const wiqlUrl = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/wiql?api-version=7.1`;
  const wi = await adoRequest("POST", wiqlUrl, { data: wiql, headers: { "Content-Type": "application/json" } });
  const ids = (wi.workItems || []).map(w => w.id);
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.State","System.WorkItemType","System.AssignedTo","System.IterationPath"];
  const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
  const details = await adoRequest("GET", detailsUrl);
  return (details.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    state: w.fields["System.State"],
    type: w.fields["System.WorkItemType"],
    assignedTo: w.fields["System.AssignedTo"]?.displayName || "Unassigned",
    iterationPath: w.fields["System.IterationPath"] || "",
  }));
}

// Keyword search (project-wide)
export async function findWorkItemsByKeyword(keyword) {
  const q = String(keyword || "").trim();
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND ([System.Title] CONTAINS '${q.replace(/'/g,"''")}' OR [System.Description] CONTAINS '${q.replace(/'/g,"''")}')
      ORDER BY [System.ChangedDate] DESC
    `,
  };
  const wiqlUrl = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/wiql?api-version=7.1`;
  const wi = await adoRequest("POST", wiqlUrl, { data: wiql, headers: { "Content-Type": "application/json" } });
  const ids = (wi.workItems || []).slice(0, 50).map(w => w.id);
  if (!ids.length) return [];
  const fields = ["System.Id","System.Title","System.State","System.WorkItemType"];
  const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
  const details = await adoRequest("GET", detailsUrl);
  return (details.value || []).map(w => ({
    id: w.id,
    title: w.fields["System.Title"],
    state: w.fields["System.State"],
    type: w.fields["System.WorkItemType"],
  }));
}

// Create Issue (Basic)
export async function createUserStory({ title, iterationPath = null }) {
  const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/workitems/$Issue?api-version=7.1`;
  const patch = [{ op: "add", path: "/fields/System.Title", value: String(title || "").trim() }];
  if (iterationPath) {
    patch.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
  }
  const headers = { "Content-Type": "application/json-patch+json" };
  return await adoRequest("PATCH", url, { data: patch, headers });
}

// Create Task (Basic) with optional parent link
export async function createTask({ title, iterationPath = null, parentId = null }) {
  const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/workitems/$Task?api-version=7.1`;
  const patch = [{ op: "add", path: "/fields/System.Title", value: String(title || "").trim() }];
  if (iterationPath) {
    patch.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
  }
  if (parentId) {
    patch.push({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${AZURE_ORG_URL}/_apis/wit/workItems/${parentId}` },
    });
  }
  const headers = { "Content-Type": "application/json-patch+json" };
  return await adoRequest("PATCH", url, { data: patch, headers });
}
