import express from "express";
import { sprintCache, searchWorkItems } from "../services/sprintDataLoader.js";
import { createUserStory, createTask, listWorkItems, getWorkItem } from "../services/workItemManager.js";
import dotenv from "dotenv";
dotenv.config();

/**
 * MCP Server implementation for Azure DevOps with SSE support
 */
export function createMCPServer() {
  const router = express.Router();

  // MCP tool definitions
  const tools = [
    {
      name: "search_work_items",
      description: "Search for Azure DevOps work items, user stories, tasks, and bugs by keyword",
      inputSchema: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "Search query string (keyword to search for)" 
          },
          type: { 
            type: "string", 
            description: "Work item type filter (optional)", 
            enum: ["Task", "User Story", "Bug", "All"] 
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_work_item",
      description: "Fetch detailed information about a specific work item by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { 
            type: "string", 
            description: "Work item ID number" 
          },
        },
        required: ["id"],
      },
    },
    {
      name: "get_current_sprint",
      description: "Get all work items in the current active sprint",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_all_sprints",
      description: "Get a summary of all loaded sprints with work item counts",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];

  // SSE endpoint for streaming MCP communication
  router.get("/sse", (req, res) => {
    console.log("🔌 SSE connection established");

    // Set headers for SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: "connection", status: "connected" })}\n\n`);

    // Keep connection alive
    const keepAliveInterval = setInterval(() => {
      res.write(`: keepalive\n\n`);
    }, 30000); // Every 30 seconds

    // Clean up on close
    req.on("close", () => {
      console.log("🔴 SSE connection closed");
      clearInterval(keepAliveInterval);
    });
  });

  // List available tools (standard endpoint)
  router.post("/list-tools", (req, res) => {
    console.log("📋 MCP: Listing available tools");
    res.json({ tools });
  });

  router.get("/tools", (req, res) => {
    console.log("📋 MCP: GET tools list");
    res.json({ tools });
  });

  // Tool: Search work items
  router.post("/tools/search_work_items", async (req, res) => {
    try {
      const { query, type = "All" } = req.body;
      console.log(`🔍 MCP: Searching work items for "${query}" (type: ${type})`);

      const results = searchWorkItems(query);

      // Filter by type if specified
      const filteredResults = type === "All" 
        ? results 
        : results.filter(item => item.type === type);

      res.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({ 
              query,
              count: filteredResults.length,
              results: filteredResults.map(r => ({
                id: r.id,
                title: r.title,
                type: r.type,
                state: r.state,
                sprint: r.sprintName,
                assignedTo: r.assignedTo,
                storyPoints: r.storyPoints,
              }))
            }, null, 2),
          },
        ],
      });
    } catch (error) {
      console.error("❌ MCP: Search error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Tool: Get work item by ID
  router.post("/tools/get_work_item", async (req, res) => {
    try {
      const { id } = req.body;
      console.log(`📄 MCP: Getting work item #${id}`);

      const workItem = await getWorkItem(id);

      if (!workItem) {
        return res.status(404).json({ 
          error: `Work item #${id} not found` 
        });
      }

      const fields = workItem.fields;
      res.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: workItem.id,
              title: fields["System.Title"],
              type: fields["System.WorkItemType"],
              state: fields["System.State"],
              description: fields["System.Description"] || "",
              assignedTo: fields["System.AssignedTo"]?.displayName || "Unassigned",
              storyPoints: fields["Microsoft.VSTS.Scheduling.StoryPoints"] || 0,
              priority: fields["Microsoft.VSTS.Common.Priority"] || 0,
              createdDate: fields["System.CreatedDate"],
              url: `${process.env.AZURE_ORG_URL}/${process.env.AZURE_PROJECT}/_workitems/edit/${workItem.id}`,
            }, null, 2),
          },
        ],
      });
    } catch (error) {
      console.error("❌ MCP: Get work item error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Tool: Get current sprint
  router.post("/tools/get_current_sprint", async (req, res) => {
    try {
      console.log("📊 MCP: Getting current sprint");

      if (sprintCache.stories.length === 0) {
        return res.json({
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              message: "No sprint data available" 
            }) 
          }],
        });
      }

      const currentSprint = sprintCache.stories[0];
      
      res.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sprintName: currentSprint.sprintName,
              sprintId: currentSprint.sprintId,
              totalStories: currentSprint.stories.length,
              totalPoints: currentSprint.stories.reduce((sum, s) => sum + (s.storyPoints || 0), 0),
              byState: {
                New: currentSprint.stories.filter(s => s.state === "New").length,
                Active: currentSprint.stories.filter(s => s.state === "Active").length,
                Resolved: currentSprint.stories.filter(s => s.state === "Resolved").length,
                Closed: currentSprint.stories.filter(s => s.state === "Closed").length,
              },
              stories: currentSprint.stories.map(s => ({
                id: s.id,
                title: s.title,
                type: s.type,
                state: s.state,
                assignedTo: s.assignedTo,
                storyPoints: s.storyPoints,
              })),
            }, null, 2),
          },
        ],
      });
    } catch (error) {
      console.error("❌ MCP: Get current sprint error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Tool: List all sprints
  router.post("/tools/list_all_sprints", async (req, res) => {
    try {
      console.log("📊 MCP: Listing all sprints");

      if (sprintCache.stories.length === 0) {
        return res.json({
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              message: "No sprint data available" 
            }) 
          }],
        });
      }

      res.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              totalSprints: sprintCache.stories.length,
              lastUpdated: sprintCache.lastUpdated,
              sprints: sprintCache.stories.map((sprint, idx) => ({
                index: idx + 1,
                name: sprint.sprintName,
                id: sprint.sprintId,
                workItemCount: sprint.stories.length,
                totalPoints: sprint.stories.reduce((sum, s) => sum + (s.storyPoints || 0), 0),
                byType: {
                  UserStory: sprint.stories.filter(s => s.type === "User Story").length,
                  Task: sprint.stories.filter(s => s.type === "Task").length,
                  Bug: sprint.stories.filter(s => s.type === "Bug").length,
                },
              })),
            }, null, 2),
          },
        ],
      });
    } catch (error) {
      console.error("❌ MCP: List sprints error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Root endpoint - MCP server info
  router.get("/", (req, res) => {
    res.json({
      name: "Azure DevOps MCP Server",
      version: "1.0.0",
      description: "Model Context Protocol server for Azure DevOps integration",
      protocol: "MCP with SSE support",
      endpoints: {
        sse: "/mcp/sse",
        tools: "/mcp/tools",
        listTools: "/mcp/list-tools"
      },
      tools: tools.length,
      status: "running",
      sprintsLoaded: sprintCache.stories.length,
      lastUpdated: sprintCache.lastUpdated,
    });
  });

  return router;
}
