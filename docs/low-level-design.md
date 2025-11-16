# Low-Level Design (LLD)

## 1. Introduction

This document provides a detailed look at the internal design of the AI-powered Azure DevOps Assistant. It breaks down the key modules, their functions, data structures, and the logic that governs their behavior.

## 2. Backend Server (`server.js`)

The `server.js` file is the main entry point of the application. It is responsible for setting up the Express server, managing Socket.IO connections, and handling the core message processing logic.

### Key Responsibilities:

-   **Server Initialization:** Sets up an Express server and integrates it with Socket.IO.
-   **Middleware:** Configures CORS and JSON parsing middleware.
-   **Environment Configuration:** Loads environment variables from `.env` and validates the presence of required Azure DevOps credentials.
-   **Socket Connection Handling:** Manages the lifecycle of user connections, including session management and disconnection events.
-   **Message Handling:** Contains the primary `handleMessage` function, which acts as a router for all incoming user messages.

### `handleMessage(sessionId, text)` Function:

This is the core of the chatbot's logic. It takes a user's message and determines the appropriate action.

-   **Input:** `sessionId` (string), `text` (string)
-   **Output:** A formatted string (HTML) to be sent back to the user.
-   **Logic:**
    1.  **Normalization:** The input text is trimmed and normalized.
    2.  **Command Matching:** The function uses a series of regular expressions to match the user's input against a set of predefined commands (e.g., `list items in sprint 2`, `create issue`, `describe #123`).
    3.  **Deterministic Logic:** For most commands, it follows a deterministic path, calling the appropriate function from `workItemManager.js` or `sprintDataLoader.js`.
    4.  **AI Fallback:** If the command is not recognized as a deterministic one and matches a natural language query pattern, the request is forwarded to the `queryWithAI` function from `Integration.js`.
    5.  **State Management:** For multi-turn interactions (like creating a work item), it uses a `conversationState` object to track the user's progress through the flow.

## 3. Azure DevOps Integration

### `workItemManager.js`

This module encapsulates all the logic for interacting with Azure DevOps work items.

-   **`createTask(options)`:** Creates a new Task in Azure DevOps.
-   **`createUserStory(options)`:** Creates a new User Story or Issue.
-   **`getWorkItem(id)`:** Retrieves a single work item by its ID, ensuring it expands relations to get linked items.
-   **`updateWorkItemState(id, state)`:** Changes the state of a work item (e.g., to "Doing" or "Done").
-   **`updateWorkItemIteration(id, iterationPath)`:** Moves a work item to a different sprint.
-   **`listItemsInIteration(options)`:** Fetches all items within a specific sprint, with optional filtering by type.
-   **`findWorkItemsByKeyword(keyword)`:** Performs a project-wide search for work items using WIQL (Work Item Query Language).
-   **`listUnassignedInToDo(options)`:** Finds all unassigned items in the "To Do" state, with optional sprint and type filters.

### `sprintDataLoader.js`

This module is responsible for loading and caching sprint data to provide quick access to board information.

-   **`loadSprintData()`:** Fetches all recent sprints and their associated work items from Azure DevOps. It populates a `sprintCache` object for fast lookups.
-   **`getCurrentSprintStories()`:** Returns a formatted summary of the items in the current sprint.
-   **`getAllSprintsSummary()`:** Provides an overview of all cached sprints.
-   **`sprintCache`:** An in-memory cache object that stores sprint data to reduce the number of API calls to Azure DevOps.

## 4. AI Service Integration (`Integration.js`)

This module handles all interactions with the OpenRouter API.

-   **`getModelName()`:** Returns the name of the AI model being used.
-   **`queryWithAI(prompt, context)`:** Sends a prompt and a context object to the OpenRouter API and returns the AI's response. The context object is built in `server.js` and provides the AI with relevant information about the current state of the sprints and work items.

## 5. Data Structures

-   **`sprintCache` Object:**
    -   `sprints`: An array of sprint metadata (name, path).
    -   `stories`: An array where each element represents a sprint and contains an array of its work items.
    -   `lastUpdated`: A timestamp indicating when the cache was last refreshed.

-   **Work Item Object (Simplified):**
    -   `id`: The work item ID.
    -   `title`: The title of the work item.
    -   `type`: The work item type (e.g., "Issue", "Task").
    -   `state`: The current state (e.g., "To Do", "Doing", "Done").
    -   `assignedTo`: The name of the person it is assigned to.
    -   `iterationPath`: The sprint path the item belongs to.

-   **`conversationState` Object:**
    -   A dictionary where keys are session IDs.
    -   Each value is an object that tracks the current `flow` (e.g., `task_awaiting_title`) and a `temp` object to store user input during a multi-turn conversation.
