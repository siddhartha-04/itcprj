# High-Level Design (HLD)

## 1. Introduction

The AI-powered Azure DevOps Assistant is a real-time chat application designed to provide a natural language interface for interacting with Azure DevOps Boards. It allows users to manage work items, track sprint progress, and receive AI-driven insights without leaving the chat interface.

## 2. System Architecture

The system follows a classic client-server architecture, with a frontend web client communicating with a backend Node.js server. The architecture is event-driven, primarily using WebSockets (via Socket.IO) for low-latency, bidirectional communication. The backend acts as a central orchestrator, integrating with external services like Azure DevOps and OpenRouter to fulfill user requests.

## 3. Core Components

The system is composed of the following major components:

-   **Frontend Client:** A web-based interface (located in the `client/` directory) that provides the user with a chat window. It establishes a persistent WebSocket connection to the backend server to send user messages and receive bot responses.

-   **Backend Server:** The core of the application, built with Node.js and Express. It is responsible for:
    -   Managing WebSocket connections with clients.
    -   Handling user messages and conversation state.
    -   Parsing user commands and routing them to the appropriate modules.
    -   Orchestrating interactions between the Azure DevOps service and the AI service.

-   **Azure DevOps Service Integration:** A collection of modules (`workItemManager.js`, `sprintDataLoader.js`) that interface directly with the Azure DevOps REST API. This component is responsible for all operations related to work items, sprints, and boards, such as creating, reading, updating, and searching for data in Azure DevOps.

-   **AI Service (OpenRouter):** The `Integration.js` module connects to the OpenRouter API, which provides access to various large language models. This component is used for natural language understanding, generating AI-powered responses, and providing intelligent summaries and suggestions.

-   **MCP Server:** An integrated server component (`mcpServer.js`) that provides additional endpoints, likely for specialized integrations or data handling.

## 4. Component Interaction Diagram

The following diagram illustrates the high-level interaction between the core components:

```mermaid
graph TD
    User -->|Sends Message| FrontendClient
    FrontendClient -->|socket.emit('user_message')| BackendServer
    BackendServer -->|Parses Command| BackendServer

    subgraph Backend Logic
        BackendServer -->|Deterministic Command| AzureDevOpsService
        BackendServer -->|NLQ / AI Query| AIService
    end

    AzureDevOpsService -->|REST API Call| AdoAPI[Azure DevOps API]
    AdoAPI -->|Work Item Data| AzureDevOpsService
    AzureDevOpsService -->|Formatted Data| BackendServer

    AIService -->|API Call| OpenRouterAPI[OpenRouter API]
    OpenRouterAPI -->|AI Response| AIService
    AIService -->|Formatted Response| BackendServer

    BackendServer -->|socket.emit('bot_message')| FrontendClient
    FrontendClient -->|Displays Response| User

```

## 5. Technology Stack

-   **Backend:** Node.js, Express.js
-   **Real-time Communication:** Socket.IO
-   **Frontend:** React (based on standard `client` structure), npm
-   **External APIs:** Azure DevOps REST API, OpenRouter API
-   **Dev Tools:** Nodemon, Concurrently
