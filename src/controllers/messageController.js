import {
  getCurrentSprintStories,
  getAllSprintsSummary,
  sprintCache,
} from '../services/sprintDataLoader.js';
import {
  createUserStory,
  createTask,
  getWorkItem,
  updateWorkItemState,
  listUnassignedInToDo,
  updateWorkItemIteration,
  listItemsInIteration,
} from '../services/workItemManager.js';
import { queryWithAI, getModelName, buildAIContext } from '../services/Integration.js';
import {
  stripHtml,
  childIdsFromRelations,
  relatedIdsFromRelations,
  resolveSprintPath,
  resolveTitleOrIdWithShortlist,
} from '../utils/helpers.js';
import logger from '../utils/logger.js';

// In-memory conversation state
const conversationState = {};

export function getHelp() {
  const aiEnabled = !!process.env.OPENROUTER_API_KEY;
  return [
    `👋 Hi — I'm your ${aiEnabled ? 'AI-powered ' : ''}Azure DevOps Assistant!`,
    "📊 Boards: current sprint, all sprints, open vs closed, list items in sprint N",
    "🔍 Items: describe #28, list tasks of #28, which bugs are linked to #28",
    "✏️ Create/Move: create issue/task in sprint N, move # to Doing, move # to sprint N",
    "💡 AI: what tasks should be completed first, when should we launch sprint 1 in other countries",
  ].join("<br>");
}

export function getOpenVsClosed() {
  const cur = sprintCache.stories[0] || null;
  if (!cur) return "⚠️ No sprint data loaded yet; please wait and try again.";
  const todo = cur.stories.filter(i => i.state === 'To Do').length;
  const doing = cur.stories.filter(i => i.state === 'Doing').length;
  const done = cur.stories.filter(i => i.state === 'Done').length;
  const open = todo + doing;
  return `Open items: ${open} (To Do: ${todo} + Doing: ${doing})<br>Closed items: ${done}`;
}

export async function listItemsInSprint(sprintNumber, itemType = null) {
  try {
    const sprintPath = resolveSprintPath(`Sprint ${sprintNumber}`);
    if (!sprintPath) return `⚠️ Sprint "Sprint ${sprintNumber}" not found; check Team Settings → Iterations.`;

    const rows = await listItemsInIteration({ iterationPath: sprintPath, type: itemType });
    const typeLabel = itemType ? `${itemType}s` : 'items';

    if (!rows.length) return `No ${typeLabel} found in Sprint ${sprintNumber}.`;

    const header = `🧾 ${itemType ? `${itemType}s` : 'Work Items'} in Sprint ${sprintNumber}`;
    return `${header}:<br>${rows.map(i => `#${i.id}: ${i.title} [${i.state}]`).join('<br>')}`;
  } catch (e) {
    logger.error(`Error in listItemsInSprint: ${e.message}`);
    return `⚠️ Unable to list items: ${e?.message || 'unexpected error'}`;
  }
}

export async function describeWorkItem(query) {
    const { id, shortlist } = await resolveTitleOrIdWithShortlist(query);

    if (!id) {
        if (shortlist && shortlist.length) {
            const tips = shortlist.map(s => `#${s.id} — ${s.title}`).join('<br>');
            return `⚠️ Could not find that work item.<br>Did you mean:<br>${tips}`;
        }
        return `⚠️ Could not find a work item matching "${query}".`;
    }

    const wi = await getWorkItem(id);
    if (!wi) return `⚠️ Work item #${id} not found.`;

    const f = wi.fields || {};
    const title = f['System.Title'] || '(Untitled)';
    const type = f['System.WorkItemType'] || 'Work Item';
    const state = f['System.State'] || 'Unknown';
    const assigned = f['System.AssignedTo']?.displayName || 'Unassigned';
    const rawHtml = f['System.Description'] || f['Microsoft.VSTS.TCM.ReproSteps'] || '';

    const header = `<b>#${wi.id}: ${title}</b><br>Type: ${type}<br>State: ${state}<br>Assigned: ${assigned}`;

    if (!String(rawHtml).trim()) {
        return `${header}<br><br>(No description provided)`;
    }

    // Prefer AI summary, with deterministic fallback
    if (process.env.OPENROUTER_API_KEY) {
        try {
            const aiCtx = await buildAIContext();
            const prompt = `Summarize the following in 4-6 concise bullets:\n\n${stripHtml(rawHtml)}`;
            const summary = await queryWithAI(prompt, aiCtx);
            if (summary && !summary.startsWith('⚠️')) {
                return `${header}<br><br>${summary}`;
            }
        } catch (e) {
            logger.error(`AI summarization failed for work item #${id}: ${e.message}`);
        }
    }

    return `${header}<br><br>${rawHtml}`;
}

export async function listChildTasks(parentQuery) {
     const { id: parentId, shortlist } = await resolveTitleOrIdWithShortlist(parentQuery);

    if (!parentId) {
        if (shortlist && shortlist.length) {
            const tips = shortlist.map(s => `#${s.id} — ${s.title}`).join('<br>');
            return `⚠️ Could not find the parent work item.<br>Did you mean:<br>${tips}`;
        }
        return `⚠️ Could not find the parent work item. Try an exact ID like #123.`;
    }

    const parent = await getWorkItem(parentId);
    if (!parent) return `⚠️ Parent work item #${parentId} not found.`;

    const childIds = childIdsFromRelations(parent);
    if (!childIds.length) return `No child Tasks found for #${parent.id} ${parent.fields['System.Title']}.`;

    const fields = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State'];
    const { default: axios } = await import('axios');
    const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${childIds.join(',')}&fields=${fields.join(',')}&api-version=7.1`;
    const headers = { Authorization: `Basic ${Buffer.from(`:${process.env.AZURE_PAT}`).toString('base64')}` };
    const { data } = await axios.get(url, { headers, timeout: 15000 });
    const tasks = (data.value || []).filter(w => w.fields['System.WorkItemType'] === 'Task');

    if (!tasks.length) return `No child Tasks found for #${parent.id}.`;

    const lines = tasks.map(w => `#${w.id} ${w.fields['System.Title']} [${w.fields['System.State']}]`);
    return `Child Tasks of #${parent.id} ${parent.fields['System.Title']}:<br>${lines.join('<br>')}`;
}

export async function createWorkItem(sprintLabel, itemType, title) {
    try {
        const path = resolveSprintPath(sprintLabel);
        if (!path) return `⚠️ Sprint "${sprintLabel}" not found.`;

        const createFn = itemType.toLowerCase() === 'issue' ? createUserStory : createTask;
        const created = await createFn({ title, iterationPath: path });

        return `✅ Created ${itemType} #${created.id} in ${sprintLabel}`;
    } catch (e) {
        logger.error(`Error in createWorkItem: ${e.message}`);
        return `⚠️ Failed to create ${itemType}: ${e.message || 'unexpected error'}`;
    }
}

export async function moveWorkItemState(id, state) {
    const stateMap = {
        todo: 'To Do', 'to do': 'To Do', 'to-do': 'To Do',
        doing: 'Doing', 'in progress': 'Doing',
        done: 'Done', completed: 'Done', complete: 'Done',
    };
    const canonicalState = stateMap[state.toLowerCase().replace(/["'“”]/g, '')];

    if (!canonicalState) return `⚠️ Unknown state "${state}". Try: To Do, Doing, Done.`;

    try {
        await updateWorkItemState(id, canonicalState);
        return `✅ Moved #${id} to ${canonicalState}.`;
    } catch (e) {
        logger.error(`Error in moveWorkItemState: ${e.message}`);
        return `⚠️ Failed to update state: ${e.message || 'unexpected error'}`;
    }
}

export async function moveWorkItemToSprint(id, sprintLabel) {
    try {
        const sprintPath = resolveSprintPath(sprintLabel);
        if (!sprintPath) return `⚠️ Sprint "${sprintLabel}" not found.`;
        await updateWorkItemIteration(id, sprintPath);
        return `✅ Moved #${id} to ${sprintLabel}.`;
    } catch (e) {
        logger.error(`Error in moveWorkItemToSprint: ${e.message}`);
        return `⚠️ Failed to move item: ${e.message || 'unexpected error'}`;
    }
}

export async function handleGenericAIQuery(text) {
    if (!process.env.OPENROUTER_API_KEY) {
        return "💡 AI is disabled. Try a specific command like 'list items in sprint 2'.";
    }
    try {
        const aiCtx = await buildAIContext();
        const response = await queryWithAI(text, aiCtx);
        return `🤖 <b>AI Assistant:</b><br><br>${response || '⚠️ AI returned no content.'}`;
    } catch (e) {
        logger.error(`Error in handleGenericAIQuery: ${e.message}`);
        return '⚠️ AI is temporarily unavailable. Please try again.';
    }
}

export async function getLinkedBugs(query) {
    try {
        const { id, shortlist } = await resolveTitleOrIdWithShortlist(query);

        if (!id) {
            if (shortlist && shortlist.length) {
                const tips = shortlist.map(s => `#${s.id} — ${s.title}`).join('<br>');
                return `⚠️ Could not find that work item.<br>Did you mean:<br>${tips}`;
            }
            return `⚠️ Could not find a work item matching "${query}".`;
        }

        const wi = await getWorkItem(id);
        if (!wi) return `⚠️ Work item #${id} not found.`;

        const allIds = relatedIdsFromRelations(wi);
        if (!allIds.length) return `No linked Bugs found for #${wi.id}.`;

        const fields = ["System.Id", "System.Title", "System.WorkItemType", "System.State"];
        const { default: axios } = await import('axios');
        const url = `${process.env.AZURE_ORG_URL}/_apis/wit/workitems?ids=${allIds.join(',')}&fields=${fields.join(',')}&api-version=7.1`;
        const headers = { Authorization: `Basic ${Buffer.from(`:${process.env.AZURE_PAT}`).toString('base64')}` };
        const { data } = await axios.get(url, { headers, timeout: 15000 });
        const bugs = (data.value || []).filter(w => w.fields["System.WorkItemType"] === "Bug");

        return bugs.length ? `Linked Bugs:<br>${bugs.map(b => `#${b.id} ${b.fields["System.Title"]} [${b.fields["System.State"]}]`).join("<br>")}` : `No linked Bugs found for #${wi.id}.`;
    } catch (e) {
        logger.error(`Error in getLinkedBugs: ${e.message}`);
        return `⚠️ Unable to fetch linked bugs: ${e.message || 'unexpected error'}`;
    }
}

export async function listIssuesWithoutChildren(sprintLabel) {
    try {
        let iterationPath = null;
        if (sprintLabel) {
            iterationPath = resolveSprintPath(sprintLabel);
            if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found.`;
        } else if (sprintCache.stories[0]?.path) {
            iterationPath = sprintCache.stories[0].path;
        } else {
            return `⚠️ No sprint context available. Try: "in sprint 2".`;
        }

        const issues = await listItemsInIteration({ iterationPath, type: "Issue" });
        if (!issues.length) return `No Issues found in that sprint.`;

        const { default: axios } = await import('axios');
        const headers = { Authorization: `Basic ${Buffer.from(`:${process.env.AZURE_PAT}`).toString('base64')}` };
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
        logger.error(`Error in listIssuesWithoutChildren: ${e.message}`);
        return `⚠️ Unable to check for childless issues: ${e.message || 'unexpected error'}`;
    }
}

export async function listUnassigned(itemType, sprintLabel) {
    try {
        let iterationPath = null;
        if (sprintLabel) {
            iterationPath = resolveSprintPath(sprintLabel);
            if (!iterationPath) return `⚠️ Sprint "${sprintLabel}" not found.`;
        }

        const rows = await listUnassignedInToDo({ type: itemType, iterationPath });
        if (!rows?.length) {
            return sprintLabel
                ? `There are no unassigned ${itemType || "items"} in To Do for ${sprintLabel}.`
                : `There are no unassigned ${itemType || "items"} in To Do.`;
        }
        const heading = sprintLabel ? `Unassigned in <b>To Do</b> (Sprint: ${sprintLabel})` : `Unassigned in <b>To Do</b>`;
        return `${heading}:<br>${rows.map((r) => `#${r.id}: ${r.title} (${r.type})`).join("<br>")}`;
    } catch (e) {
        logger.error(`Error in listUnassigned: ${e.message}`);
        return `⚠️ Unable to list unassigned items: ${e.message || 'unexpected error'}`;
    }
}
