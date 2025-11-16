import * as controller from './messageController.js';
import { getCurrentSprintStories, getAllSprintsSummary } from '../services/sprintDataLoader.js';

const commandRoutes = [
  {
    pattern: /^(hi|hello|hey|help)$/i,
    handler: controller.getHelp,
  },
  {
    pattern: /open\s+vs\s+closed/i,
    handler: controller.getOpenVsClosed,
  },
  {
    pattern: /^\s*list\s+(issues|tasks|items)\s+in\s+sprint\s+(.+?)\s*$/i,
    handler: (text) => {
      const match = text.match(/^\s*list\s+(issues|tasks|items)\s+in\s+sprint\s+(.+?)\s*$/i);
      const itemType = match[1] === 'items' ? null : match[1].charAt(0).toUpperCase() + match[1].slice(1, -1);
      return controller.listItemsInSprint(match[2], itemType);
    },
  },
    {
    pattern: /^\s*(?:show|list|lists)\s+(?:the\s+)?(?:issues?\s+and\s+tasks?|tasks?\s+and\s+issues?)\s+(?:in|of)\s+sprint\s+(\d+)\s*\.?$/i,
    handler: (text) => {
        const match = text.match(/^\s*(?:show|list|lists)\s+(?:the\s+)?(?:issues?\s+and\s+tasks?|tasks?\s+and\s+issues?)\s+(?:in|of)\s+sprint\s+(\d+)\s*\.?$/i);
        return controller.listItemsInSprint(match[1]);
    }
  },
  {
    pattern: /^(?:what\s+is|describe|explain)\s+(.+)$/i,
    handler: text => controller.describeWorkItem(text.match(/^(?:what\s+is|describe|explain)\s+(.+)$/i)[1]),
  },
  {
    pattern: /^(?:list|show)\s+tasks?\s+of\s+(.+)$/i,
    handler: text => controller.listChildTasks(text.match(/^(?:list|show)\s+tasks?\s+of\s+(.+)$/i)[1]),
  },
    {
    pattern: /^create\s+(issue|task)\s+in\s+sprint\s+(.+?):\s*(.+)$/i,
    handler: (text) => {
      const match = text.match(/^create\s+(issue|task)\s+in\s+sprint\s+(.+?):\s*(.+)$/i);
      return controller.createWorkItem(match[2], match[1], match[3]);
    },
  },
  {
    pattern: /^move\s+(#?\d+)\s+to\s+(.+?)$/i,
    handler: (text) => {
      const match = text.match(/^move\s+(#?\d+)\s+to\s+(.+?)$/i);
      const stateOrSprint = match[2].toLowerCase();
      if (stateOrSprint.startsWith('sprint')) {
        return controller.moveWorkItemToSprint(match[1], stateOrSprint);
      }
      return controller.moveWorkItemState(match[1], stateOrSprint);
    },
  },
  {
    pattern: /current sprint/i,
    handler: getCurrentSprintStories,
  },
  {
    pattern: /all sprints/i,
    handler: getAllSprintsSummary,
  },
];

export async function routeCommand(text) {
  const normalizedText = text.trim().replace(/^[\s"'`“”‘’•\-–—]+/, '').replace(/[.!?]+$/, '');

  for (const route of commandRoutes) {
    if (route.pattern.test(normalizedText)) {
      return await route.handler(normalizedText);
    }
  }

  // Fallback to AI if no command matches
  if (normalizedText.length > 10) {
    return await controller.handleGenericAIQuery(normalizedText);
  }

  return "💡 Try 'help' to see a list of commands.";
}
