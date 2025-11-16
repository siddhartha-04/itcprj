# AI-powered Azure DevOps Assistant

This project is a chatbot designed to streamline your Azure DevOps workflow. It allows you to interact with your Azure Boards using natural language commands, create and manage work items, view sprint progress, and leverage an AI assistant for more complex queries.

## Key Features

- **Work Item Management:**
  - Create User Stories, Issues, and Tasks with guided prompts or quick commands.
  - View details of any work item by its ID.
  - Update the state of a work item (e.g., move from "To Do" to "Doing").
  - Reassign a work item to a different sprint.
- **Sprint and Board Views:**
  - Get a summary of the current sprint's status.
  - View an overview of all recent sprints.
  - List all items (or filter by type like Issue/Task) within a specific sprint.
- **Search and Query:**
  - Search for work items across the project using keywords.
  - Identify unassigned items in the "To Do" state.
  - List child tasks for a given parent item.
  - View bugs linked to a specific work item.
- **AI-Powered Assistance:**
  - Ask natural language questions about your sprints and backlog.
  - Get AI-generated summaries and descriptions of work items.
  - Receive intelligent suggestions for project risks, blockers, and planning.

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm
- An Azure DevOps organization and project
- An OpenRouter API key (optional, for AI features)

### Installation and Setup

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/your-username/azure-devops-chatbot.git
    cd azure-devops-chatbot
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Set up your environment variables:**

    Create a `.env` file in the root of the project and add the following variables:

    ```env
    AZURE_ORG_URL="your-azure-organization-url"
    AZURE_PROJECT="your-azure-project-name"
    AZURE_PAT="your-personal-access-token"
    PORT=3001

    # Optional: for AI features
    OPENROUTER_API_KEY="your-openrouter-api-key"
    ```

    - `AZURE_ORG_URL`: The URL of your Azure DevOps organization (e.g., `https://dev.azure.com/your-org`).
    - `AZURE_PROJECT`: The name of your Azure DevOps project.
    - `AZURE_PAT`: A Personal Access Token with read/write access to your work items.
    - `OPENROUTER_API_KEY`: Your API key from [OpenRouter](https://openrouter.ai/) to enable AI features.

4.  **Start the server:**

    ```bash
    npm start
    ```

    The server will be running at `http://localhost:3001`.

## Usage

Once the server is running, you can connect to it using a Socket.IO client or use the provided web interface. Here are some example commands you can use:

-   **Get help:**
    `help`

-   **View sprint information:**
    `current sprint`
    `all sprints`
    `list items in sprint 2`
    `list issues in sprint 1`
    `list tasks in sprint 2`
    `open vs closed`

-   **Manage work items:**
    `create issue in sprint 2: "Fix login bug"`
    `create task in sprint 1: "Update documentation"`
    `describe #123`
    `list tasks of #123`
    `move #123 to Doing`
    `move #124 to sprint 3`

-   **Search and query:**
    `search work items "login"`
    `which items are unassigned in To Do`
    `which bugs are linked to #123`

-   **AI-powered queries:**
    `what are the main risks in the current sprint?`
    `summarize the last two sprints`
    `what should we focus on next?`

## Architecture Overview

This project's architecture is designed to be modular and scalable. For a deeper understanding of the system design and data flows, please refer to the following documents:

-   **[High-Level Design (HLD)](./docs/high-level-design.md):** An overview of the system architecture, core components, and their interactions.
-   **[Low-Level Design (LLD)](./docs/low-level-design.md):** A detailed breakdown of the key modules, their functions, and data structures.
-   **[Data Flow Diagram (DFD)](./docs/data-flow.md):** Visual diagrams illustrating how data moves through the system for common user scenarios.
