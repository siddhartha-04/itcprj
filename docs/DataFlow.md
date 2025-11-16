# Data Flow Diagram (DFD)

This document illustrates the flow of data through the AI-powered Azure DevOps Assistant for common user scenarios. The diagrams are created using Mermaid.js.

## 1. User Sends a Simple Message (e.g., "current sprint")

This diagram shows the data flow for a deterministic command that can be handled directly by the backend.

```mermaid
sequenceDiagram
    participant User
    participant FrontendClient as Frontend
    participant BackendServer as Server
    participant SprintDataLoader as Sprint Loader
    participant AzureDevOpsAPI as ADO API

    User->>+Frontend: Types "current sprint"
    Frontend->>+Server: emit('user_message', { text: "current sprint" })
    Server->>Server: handleMessage(): Matches command
    Server->>+SprintLoader: getCurrentSprintStories()
    SprintLoader->>SprintLoader: Access sprintCache
    Note right of SprintLoader: Data is already cached
    SprintLoader-->>-Server: Returns formatted sprint data
    Server->>-Frontend: emit('bot_message', { html: "..." })
    Frontend-->>-User: Displays current sprint info
```

## 2. User Creates a Work Item (e.g., "create task")

This diagram illustrates the multi-turn flow of creating a work item, which involves state management.

```mermaid
sequenceDiagram
    participant User
    participant FrontendClient as Frontend
    participant BackendServer as Server
    participant WorkItemManager as WI Manager
    participant AzureDevOpsAPI as ADO API

    User->>+Frontend: Types "create task"
    Frontend->>+Server: emit('user_message', { text: "create task" })
    Server->>Server: handleMessage(): Initiates 'create_task' flow
    Server->>Server: conversationState[sessionId] = { flow: 'task_awaiting_title' }
    Server-->>-Frontend: emit('bot_message', { text: "What is the task title?" })
    Frontend-->>-User: Displays prompt for title

    User->>+Frontend: Enters title
    Frontend->>+Server: emit('user_message', { text: "New Task Title" })
    Server->>Server: handleMessage(): Stores title in temp state
    Server->>Server: conversationState[sessionId].temp.title = "..."
    Server-->>-Frontend: emit('bot_message', { text: "Add a description..." })
    Frontend-->>-User: Displays prompt for description

    User->>+Frontend: Enters description
    Frontend->>+Server: emit('user_message', { text: "Description..." })
    Server->>Server: handleMessage(): Stores description, finalizes flow
    Server->>+WI Manager: createTask({ title: "...", description: "..." })
    WI Manager->>+ADO API: POST /wit/workitems/$Task
    ADO API-->>-WI Manager: Returns created task data
    WI Manager-->>-Server: Returns success message
    Server->>-Frontend: emit('bot_message', { html: "✅ Created Task #123" })
    Frontend-->>-User: Displays confirmation message
```

## 3. User Asks an AI-Powered Question

This diagram shows the flow for a natural language query that is handled by the AI service.

```mermaid
sequenceDiagram
    participant User
    participant FrontendClient as Frontend
    participant BackendServer as Server
    participant IntegrationJS as AI Service
    participant OpenRouterAPI as AI API

    User->>+Frontend: Types "what are the main risks?"
    Frontend->>+Server: emit('user_message', { text: "what are the main risks?" })
    Server->>Server: handleMessage(): No deterministic match, routes to AI
    Server->>Server: buildAIContext(): Gathers sprint stats and data
    Server->>+AI Service: queryWithAI(prompt, context)
    AI Service->>+OpenRouterAPI: POST /chat/completions
    OpenRouterAPI-->>-AI Service: Returns AI-generated response
    AI Service-->>-Server: Returns formatted AI response
    Server->>-Frontend: emit('bot_message', { html: "🤖 AI Assistant: ..." })
    Frontend-->>-User: Displays AI-powered answer
```
