// sprintDataLoader.js
/*import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT } = process.env;

const authHeader = {
  Authorization: "Basic " + Buffer.from(":" + AZURE_PAT).toString("base64"),
  "Content-Type": "application/json",
};

export const sprintCache = { sprints: [], stories: [], lastUpdated: null };

async function fetchSprints(teamId) {
  try {
    const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/${teamId}/_apis/work/teamsettings/iterations?api-version=7.1`;
    const { data } = await axios.get(url, { headers: authHeader });
    const rows = data.value || [];
    rows.sort((a, b) => new Date(b.attributes?.startDate || 0) - new Date(a.attributes?.startDate || 0));
    return rows;
  } catch (e) {
    console.error("❌ Error fetching sprints:", e.response?.data || e.message);
    return [];
  }
}

async function fetchIterationWorkItems(teamId, iterationId) {
  try {
    const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/${teamId}/_apis/work/teamsettings/iterations/${iterationId}/workitems?api-version=7.1`;
    const { data } = await axios.get(url, { headers: authHeader });
    const ids = (data.workItemRelations || []).map(r => r.target?.id).filter(Boolean);
    if (!ids.length) return [];
    const fields = [
      "System.Title","System.WorkItemType","System.State","System.AssignedTo",
      "System.Description","Microsoft.VSTS.Common.Priority",
      "Microsoft.VSTS.Scheduling.StoryPoints","Microsoft.VSTS.Scheduling.RemainingWork",
      "System.IterationPath","System.CreatedDate"
    ];
    const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
    const { data: details } = await axios.get(detailsUrl, { headers: authHeader });
    return (details.value || []).map(wi => ({
      id: wi.id,
      title: wi.fields["System.Title"],
      type: wi.fields["System.WorkItemType"],
      state: wi.fields["System.State"],
      assignedTo: wi.fields["System.AssignedTo"]?.displayName || "Unassigned",
      description: wi.fields["System.Description"] || "",
      priority: wi.fields["Microsoft.VSTS.Common.Priority"] ?? null,
      storyPoints: wi.fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0,
      remainingWork: wi.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? null,
      iterationPath: wi.fields["System.IterationPath"] || "",
      createdDate: wi.fields["System.CreatedDate"] || null,
    }));
  } catch (e) {
    console.error("❌ Error fetching iteration work items:", e.response?.data || e.message);
    return [];
  }
}

async function fetchAllWorkItems() {
  try {
    const wiql = { query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
      ORDER BY [System.CreatedDate] DESC
    `};
    const wiqlUrl = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/wiql?api-version=7.1`;
    const { data: wiqlRes } = await axios.post(wiqlUrl, wiql, { headers: authHeader });
    const ids = (wiqlRes.workItems || []).slice(0, 200).map(w => w.id);
    if (!ids.length) return [];
    const fields = [
      "System.Title","System.WorkItemType","System.State","System.AssignedTo",
      "System.Description","Microsoft.VSTS.Common.Priority",
      "Microsoft.VSTS.Scheduling.StoryPoints","Microsoft.VSTS.Scheduling.RemainingWork",
      "System.IterationPath","System.CreatedDate"
    ];
    const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
    const { data: details } = await axios.get(detailsUrl, { headers: authHeader });
    return (details.value || []).map(wi => ({
      id: wi.id,
      title: wi.fields["System.Title"],
      type: wi.fields["System.WorkItemType"],
      state: wi.fields["System.State"],
      assignedTo: wi.fields["System.AssignedTo"]?.displayName || "Unassigned",
      description: wi.fields["System.Description"] || "",
      priority: wi.fields["Microsoft.VSTS.Common.Priority"] ?? null,
      storyPoints: wi.fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0,
      remainingWork: wi.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? null,
      iterationPath: wi.fields["System.IterationPath"] || "No Sprint",
      createdDate: wi.fields["System.CreatedDate"] || null,
    }));
  } catch (e) {
    console.error("❌ Error fetching all work items:", e.response?.data || e.message);
    return [];
  }
}

export async function loadSprintData() {
  try {
    logger.info("📊 Loading sprint data...");
    const teamsUrl = `${AZURE_ORG_URL}/_apis/projects/${AZURE_PROJECT}/teams?api-version=7.1`;
    const { data: teamsRes } = await axios.get(teamsUrl, { headers: authHeader });
    const teams = teamsRes.value || [];
    if (!teams.length) {
      console.log("⚠️ No teams; loading all work items...");
      const allItems = await fetchAllWorkItems();
      sprintCache.sprints = [];
      sprintCache.stories = [{ sprintName: "All Work Items", sprintId: "all", path: "/", stories: allItems }];
      sprintCache.lastUpdated = new Date();
      console.log(`✅ Loaded ${allItems.length} work items (fallback)`);
      return;
    }

    const teamId = teams[0].id;
    const sprints = await fetchSprints(teamId);
    if (!sprints.length) {
      console.log("⚠️ No iterations; loading all work items...");
      const allItems = await fetchAllWorkItems();
      sprintCache.sprints = [];
      sprintCache.stories = [{ sprintName: "All Work Items", sprintId: "all", path: "/", stories: allItems }];
      sprintCache.lastUpdated = new Date();
      console.log(`✅ Loaded ${allItems.length} work items (fallback)`);
      return;
    }

    const latest = sprints.slice(0, 5);
    sprintCache.sprints = latest;
    sprintCache.stories = [];
    let total = 0;
    for (const sp of latest) {
      const items = await fetchIterationWorkItems(teamId, sp.id);
      sprintCache.stories.push({ sprintName: sp.name, sprintId: sp.id, path: sp.path, stories: items });
      total += items.length;
    }
    sprintCache.lastUpdated = new Date();
    console.log(`✅ Loaded ${latest.length} sprints with ${total} total items`);
  } catch (e) {
    console.error("❌ Error loading sprint data:", e.response?.data || e.message);
    console.log("⚠️ Fallback: all work items");
    const allItems = await fetchAllWorkItems();
    sprintCache.sprints = [];
    sprintCache.stories = [{ sprintName: "All Work Items", sprintId: "all", path: "/", stories: allItems }];
    sprintCache.lastUpdated = new Date();
    console.log(`✅ Loaded ${allItems.length} work items (fallback mode)`);
  }
}

export function getCurrentSprintStories() {
  if (!sprintCache.stories.length) return "⚠️ No sprint data loaded yet; please wait and try again.";
  const current = sprintCache.stories[0];
  let out = `📋 <b>Current Sprint: ${current.sprintName}</b><br><br>`;
  out += `<b>Total Items:</b> ${current.stories.length}<br><br>`;
  current.stories.forEach(it => {
    out += `<b>#${it.id}</b>: ${it.title} [${it.state}]<br>`;
    out += `  Type: ${it.type} | Points: ${it.storyPoints || 0} | Remaining: ${it.remainingWork ?? "n/a"} | Assigned: ${it.assignedTo}<br><br>`;
  });
  return out;
}

export function getAllSprintsSummary() {
  if (!sprintCache.stories.length) return "⚠️ No sprint data available.";
  let out = `📊 <b>Sprint Overview (Last ${sprintCache.stories.length} Sprint${sprintCache.stories.length > 1 ? "s" : ""})</b><br><br>`;
  sprintCache.stories.forEach((bucket, idx) => {
    const totalPoints = bucket.stories.reduce((sum, s) => sum + (s.storyPoints || 0), 0);
    const totalRemain = bucket.stories.reduce((sum, s) => sum + (Number(s.remainingWork) || 0), 0);
    out += `<b>${idx + 1}. ${bucket.sprintName}</b><br>`;
    out += `  • Items: ${bucket.stories.length} | Story Points: ${totalPoints} | Remaining Work: ${totalRemain}<br><br>`;
  });
  out += `<br><i>Last updated: ${sprintCache.lastUpdated?.toLocaleString()}</i>`;
  return out;
}

export function searchWorkItems(term) {
  if (!term || !sprintCache.stories.length) return [];
  const q = term.toLowerCase();
  const results = [];
  sprintCache.stories.forEach(bucket => {
    bucket.stories.forEach(s => {
      const blob = `${s.title} ${s.description} ${s.type}`.toLowerCase();
      if (blob.includes(q)) results.push({ ...s, sprintName: bucket.sprintName });
    });
  });
  return results;
}*/
// sprintDataLoader.js — robust loader: true current-by-date, stable cache, explicit Iteration Paths, includes description
// sprintDataLoader.js — robust loader: true current-by-date, stable cache, explicit Iteration Paths, includes description
import axios from "axios";
import dotenv from "dotenv";
import logger from '../utils/logger.js';
dotenv.config();

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT } = process.env;

const authHeader = {
  Authorization: "Basic " + Buffer.from(":" + AZURE_PAT).toString("base64"),
  "Content-Type": "application/json",
};

export const sprintCache = { sprints: [], stories: [], lastUpdated: null };

// Preserve last good cache to prevent regressions on transient failures
let lastGood = null;

// Raw iterations for a team
async function fetchSprints(teamId) {
  const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/${teamId}/_apis/work/teamsettings/iterations?api-version=7.1`;
  const { data } = await axios.get(url, { headers: authHeader });
  return data.value || [];
}

// Order iterations so index 0 is true current sprint (start ≤ now ≤ finish), then recent past, then upcoming
function orderIterationsByCurrent(sprints) {
  const now = new Date();
  const withDates = (sprints || []).map(s => ({
    ...s,
    start: s.attributes?.startDate ? new Date(s.attributes.startDate) : null,
    finish: s.attributes?.finishDate ? new Date(s.attributes.finishDate) : null,
  }));
  const current = withDates.filter(s => s.start && s.finish && s.start <= now && now <= s.finish);
  const past = withDates.filter(s => s.finish && s.finish < now).sort((a,b) => b.start - a.start);
  const future = withDates.filter(s => s.start && s.start > now).sort((a,b) => a.start - b.start);
  return [...current, ...past, ...future];
}

// Items within an iteration (batch fields)
async function fetchIterationWorkItems(teamId, iterationId) {
  const url = `${AZURE_ORG_URL}/${AZURE_PROJECT}/${teamId}/_apis/work/teamsettings/iterations/${iterationId}/workitems?api-version=7.1`;
  const { data } = await axios.get(url, { headers: authHeader });
  const ids = (data.workItemRelations || []).map(r => r.target?.id).filter(Boolean);
  if (!ids.length) return [];

  const fields = [
    "System.Title","System.WorkItemType","System.State","System.AssignedTo",
    "System.Description","Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Scheduling.StoryPoints","Microsoft.VSTS.Scheduling.RemainingWork",
    "System.IterationPath","System.CreatedDate"
  ];
  const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
  const { data: details } = await axios.get(detailsUrl, { headers: authHeader });
  return (details.value || []).map(wi => ({
    id: wi.id,
    title: wi.fields["System.Title"],
    type: wi.fields["System.WorkItemType"],
    state: wi.fields["System.State"],
    assignedTo: wi.fields["System.AssignedTo"]?.displayName || "Unassigned",
    description: wi.fields["System.Description"] || "",
    priority: wi.fields["Microsoft.VSTS.Common.Priority"] ?? null,
    storyPoints: wi.fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0,
    remainingWork: wi.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? 0,
    iterationPath: wi.fields["System.IterationPath"] || "",
    createdDate: wi.fields["System.CreatedDate"] || null,
  }));
}

// Fallback: project-wide recent items (only if no teams/iterations)
async function fetchAllWorkItems() {
  const wiql = { query: `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.TeamProject] = @project
    ORDER BY [System.CreatedDate] DESC
  `};
  const wiqlUrl = `${AZURE_ORG_URL}/${AZURE_PROJECT}/_apis/wit/wiql?api-version=7.1`;
  const { data: wiqlRes } = await axios.post(wiqlUrl, wiql, { headers: authHeader });
  const ids = (wiqlRes.workItems || []).slice(0, 200).map(w => w.id);
  if (!ids.length) return [];

  const fields = [
    "System.Title","System.WorkItemType","System.State","System.AssignedTo",
    "System.Description","Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Scheduling.StoryPoints","Microsoft.VSTS.Scheduling.RemainingWork",
    "System.IterationPath","System.CreatedDate"
  ];
  const detailsUrl = `${AZURE_ORG_URL}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.1`;
  const { data: details } = await axios.get(detailsUrl, { headers: authHeader });
  return (details.value || []).map(wi => ({
    id: wi.id,
    title: wi.fields["System.Title"],
    type: wi.fields["System.WorkItemType"],
    state: wi.fields["System.State"],
    assignedTo: wi.fields["System.AssignedTo"]?.displayName || "Unassigned",
    description: wi.fields["System.Description"] || "",
    priority: wi.fields["Microsoft.VSTS.Common.Priority"] ?? null,
    storyPoints: wi.fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0,
    remainingWork: wi.fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? 0,
    iterationPath: wi.fields["System.IterationPath"] || "No Sprint",
    createdDate: wi.fields["System.CreatedDate"] || null,
  }));
}

export async function loadSprintData() {
  try {
    logger.info("📊 Loading sprint data...");
    const teamsUrl = `${AZURE_ORG_URL}/_apis/projects/${AZURE_PROJECT}/teams?api-version=7.1`;
    const { data: teamsRes } = await axios.get(teamsUrl, { headers: authHeader });
    const teams = teamsRes.value || [];

    if (!teams.length) {
      const allItems = await fetchAllWorkItems();
      sprintCache.sprints = [];
      sprintCache.stories = [{ sprintName: "All Work Items", sprintId: "all", path: "/", stories: allItems }];
      sprintCache.lastUpdated = new Date();
      lastGood = { ...sprintCache };
      logger.info(`✅ Loaded ${allItems.length} work items (fallback)`);
      return;
    }

    const teamId = teams[0].id;
    const raw = await fetchSprints(teamId);
    if (!raw.length) {
      const allItems = await fetchAllWorkItems();
      sprintCache.sprints = [];
      sprintCache.stories = [{ sprintName: "All Work Items", sprintId: "all", path: "/", stories: allItems }];
      sprintCache.lastUpdated = new Date();
      lastGood = { ...sprintCache };
      logger.info(`✅ Loaded ${allItems.length} work items (fallback)`);
      return;
    }

    const ordered = orderIterationsByCurrent(raw);
    const selected = ordered.slice(0, 5);

    sprintCache.sprints = selected;
    sprintCache.stories = [];
    let total = 0;
    for (const sp of selected) {
      const items = await fetchIterationWorkItems(teamId, sp.id);
      sprintCache.stories.push({ sprintName: sp.name, sprintId: sp.id, path: sp.path, stories: items });
      total += items.length;
    }
    sprintCache.lastUpdated = new Date();
    lastGood = { ...sprintCache };
    logger.info(`✅ Loaded ${selected.length} sprints (current-first) with ${total} total items`);
  } catch (e) {
    logger.error(`❌ Error loading sprint data: ${e.response?.data || e.message}`);
    if (lastGood) {
      sprintCache.sprints = lastGood.sprints;
      sprintCache.stories = lastGood.stories;
      sprintCache.lastUpdated = lastGood.lastUpdated;
      logger.info("↩️ Restored last good sprint cache.");
      return;
    }
    const allItems = await fetchAllWorkItems();
    sprintCache.sprints = [];
    sprintCache.stories = [{ sprintName: "All Work Items", sprintId: "all", path: "/", stories: allItems }];
    sprintCache.lastUpdated = new Date();
    lastGood = { ...sprintCache };
    logger.info(`✅ Loaded ${allItems.length} work items (fallback mode)`);
  }
}

export function getCurrentSprintStories() {
  if (!sprintCache.stories.length) return "⚠️ No sprint data loaded yet; please wait and try again.";
  const current = sprintCache.stories[0];

  const todo = current.stories.filter(s => s.state === "To Do").length;
  const doing = current.stories.filter(s => s.state === "Doing").length;
  const done = current.stories.filter(s => s.state === "Done").length;
  const totalPoints = current.stories.reduce((sum, s) => sum + (s.storyPoints || 0), 0);
  const totalRemain = current.stories.reduce((sum, s) => sum + (Number(s.remainingWork) || 0), 0);

  let out = `📋 <b>Current Sprint: ${current.sprintName}</b><br>`;
  out += `Items: ${current.stories.length} | To Do: ${todo} | Doing: ${doing} | Done: ${done} | Story Points: ${totalPoints} | Remaining Work: ${totalRemain}<br><br>`;
  current.stories.forEach(it => {
    out += `<b>#${it.id}</b>: ${it.title} [${it.state}] — ${it.type}; Points: ${it.storyPoints || 0}; Remaining: ${it.remainingWork ?? 0}; Assigned: ${it.assignedTo}<br>`;
  });
  return out;
}

export function getAllSprintsSummary() {
  if (!sprintCache.stories.length) return "⚠️ No sprint data available.";
  let out = `📊 <b>Sprint Overview (Last ${sprintCache.stories.length} Sprint${sprintCache.stories.length > 1 ? "s" : ""})</b><br><br>`;
  sprintCache.stories.forEach((bucket, idx) => {
    const todo = bucket.stories.filter(s => s.state === "To Do").length;
    const doing = bucket.stories.filter(s => s.state === "Doing").length;
    const done = bucket.stories.filter(s => s.state === "Done").length;
    const totalPoints = bucket.stories.reduce((sum, s) => sum + (s.storyPoints || 0), 0);
    const totalRemain = bucket.stories.reduce((sum, s) => sum + (Number(s.remainingWork) || 0), 0);
    out += `<b>${idx + 1}. ${bucket.sprintName}</b><br>`;
    out += `  • Items: ${bucket.stories.length} | To Do: ${todo} | Doing: ${doing} | Done: ${done} | Story Points: ${totalPoints} | Remaining Work: ${totalRemain}<br><br>`;
  });
  out += `<br><i>Last updated: ${sprintCache.lastUpdated?.toLocaleString()}</i>`;
  return out;
}

export function searchWorkItems(term) {
  if (!term || !sprintCache.stories.length) return [];
  const q = term.toLowerCase();
  const results = [];
  sprintCache.stories.forEach(bucket => {
    bucket.stories.forEach(s => {
      const blob = `${s.title} ${s.description} ${s.type}`.toLowerCase();
      if (blob.includes(q)) results.push({ ...s, sprintName: bucket.sprintName });
    });
  });
  return results;
}
