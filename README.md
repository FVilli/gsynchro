# gsynchro

**Bidirectional synchronization for a selected set of project files and a local directory.**

`gsynchro` is a small Node.js command-line tool for keeping documentation and other text files in a project synchronized with a second directory. The second directory can be a locally available Google Drive folder, provided by [Google Drive for desktop](https://www.google.com/drive/download/) on Windows and macOS, or a mount managed with [rclone](https://rclone.org/) on Linux or other supported platforms.

![Agentic development workflow showing the role of GSynchro](https://unpkg.com/gsynchro@latest/schema.png)

The “G” in **gSynchro** has a useful double reading: **Google Drive** is the shared transport, while **governance** is the project context being synchronized.

## Project governance and focused context

A software project contains three broad kinds of files:

| Project material | Examples | Main purpose |
| --- | --- | --- |
| **Code** | Source files, tests, scripts, assets | Implements the product |
| **Configuration and delivery setup** | `package.json`, JSON/YAML settings, Dockerfiles, CI/CD workflows | Describes how the software is built, configured, tested, and deployed |
| **Documentation** | Markdown, text, Word documents | Explains the product, its design, operation, and constraints |

Documentation serves both people and AI agents. The subset written to guide agents is the project's **governance**: the durable instructions and decisions that tell an agent what the project is for, how it should behave, what boundaries it must respect, and how work is accepted. Governance can include the product brief, goals and non-goals, requirements, architecture, design decisions, coding conventions, security constraints, task templates, and completion criteria. Files such as `AGENTS.md`, `DECISIONS.md`, and `docs/architecture.md` are examples; governance is a role the documentation plays, not a special file format.

The preferred workflow keeps high-level product and architecture discussions out of the code editor. During that phase, use ChatGPT Projects or another chatbot with access to a current Google Drive source folder containing the project's governance documents. Give the conversation this focused context without asking it to inspect the source tree. This keeps design reasoning centered on goals, requirements, constraints, and decisions instead of spending context on implementation details before they are needed.

Once a design decision is ready to implement, turn it into an explicit task file. `gsynchro` can synchronize that task and the selected governance documents into the local repository. The coding agent then reads the task and governance, opens the code and relevant configuration, and implements the approved change. This separates **deciding what to build and why** from **deciding how to change the code**.

In this model, `gsynchro` moves the governed project context and task handoffs between Drive and the repository. It does not synchronize source code. Its current safety filter allows `.md`, `.txt`, and `.json`; use `items` to select the documentation and task files that should travel. YAML files, Dockerfiles, and other configuration formats are not eligible under the fixed filter.

## Agentic development scenarios

The schema above shows the role `gsynchro` can play in an agentic workflow: it is the file bridge between a conversational AI workspace, Google Drive, and the repository where coding agents work. This is not limited to ChatGPT Projects. **Any chatbot can be the conversational interface** if it can connect to the project's Google Drive folder and read the current source files. Connectors differ: some retrieve files on demand, while others use an index that refreshes periodically. Check the provider's access, file-type, freshness, and write capabilities before relying on it for a live handoff.

The workflow separates four roles:

1. **Conversational AI for product thinking.** Discuss the problem, explore alternatives, design the architecture, record decisions, and draft implementation tasks. ChatGPT Projects are one option; a cloud Project uses connected sources and is distinct from a local project that reads a folder on the computer. See OpenAI's [Projects and chats](https://learn.chatgpt.com/docs/projects) documentation.
2. **Google Drive for shared project files.** Keep the approved Markdown documentation and task files in a project-specific Drive folder. The chatbot connector lets conversations consult Drive; a desktop client or `rclone` makes the same files available to the machine running the agent.
3. **`gsynchro` for synchronization.** Copy only the selected files between the repository and the mounted Drive folder. A task such as `tasks/todo/TASK-042.md` can arrive in the repository, and the agent's updated task and documentation can travel back to Drive.
4. **An agent runner for execution.** A separate local process watches a designated task inbox. It waits for a complete task, starts a coding agent in the repository, and records the result. `gsynchro` synchronizes files; it does not interpret tasks, run the coding agent, or connect a filesystem event to a chatbot conversation.

The Drive connection is a source for chatbot conversations; it is not an operating-system mount or a file-change trigger. If a chatbot connector is read-only or does not write Markdown files, save or export the approved task to Drive yourself. The local watcher, after the file has arrived in the repository, is what turns that handoff into an automatic agent run.

### Scenario A: a development computer at home

Leave the development computer on with the repository, Drive client or mount, `gsynchro`, and the separate agent runner available. You can discuss requirements from ChatGPT or another connected chatbot, save an approved task into the Drive folder, and let the computer carry out the implementation locally. Source code stays in the repository; `gsynchro` synchronizes the selected task and documentation files.

OpenAI currently documents ChatGPT Voice in the desktop app for Chat, Work, and Codex. ChatGPT Projects can contain Chat and Work conversations, so voice can be used in a Project conversation where the voice control is available. OpenAI also documents Remote on iOS after pairing a phone with a desktop host. Availability depends on account, workspace, and rollout; see [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice). This voice control can steer supported ChatGPT/Codex work. It does **not** automatically control an unrelated custom watcher or agent daemon: that runner still needs an explicit integration, or you can hand work to it as a task file in Drive.

Typical local flow:

```text
ChatGPT / another Drive-connected chatbot
       ↓ approved task saved in Google Drive
Google Drive for desktop
       ↓ local project folder
gsynchro ⇄ local repository
       ↓ tasks/todo/*.md appears
local task runner → coding agent → repository changes
       ↓ task result and selected docs
gsynchro → Google Drive → available to chatbot conversations
```

The machine, mount, `gsynchro`, and runner must be active for automatic local execution. If the computer is off or the mount is unavailable, the task stays in Drive until synchronization and the runner resume.

### Scenario B: an always-on cloud server

Run the repository and agent runner on a Linux server or VM instead of a home workstation. Install the coding agent's runtime there, clone the project repository, mount the Google Drive folder with `rclone`, and keep both `gsynchro` and the task runner running as services. In this setup, rclone exposes the cloud folder as a filesystem path and `gsynchro` connects that path to the server's repository.

For example, if rclone mounts Drive at `/srv/gdrive`, the gsynchro configuration can point at a dedicated subdirectory:

```yaml
destination: /srv/gdrive/projects/my-project
debounce: 5
items:
  - "README.md"
  - "AGENTS.md"
  - "docs/**/*.md"
  - "tasks/**/*.md"
```

The task-file flow is the same: an approved Markdown task is written to `tasks/todo/` in Drive, rclone exposes it on the server, `gsynchro` copies it into the repository, and the server-side runner starts the coding agent. The server then writes task status and documentation updates locally, and `gsynchro` sends those selected files back to Drive. Keep the Drive mount, `gsynchro`, and the runner under a service manager so they recover after a reboot; the `gsynchro` and runner services need their own service definitions. See the [Linux rclone setup guide](https://github.com/FVilli/gsynchro/blob/main/docs/linux-rclone.md) for the rclone remote, mount, and systemd setup.

The chatbot remains the planning and control surface. To control a server-side runner directly, provide a separate remote interface or integration; a Drive source link alone does not execute commands on the server. A task file in the mounted Drive folder is a simple asynchronous handoff that the runner can observe.

### Example project layout

```text
my-project/
├── .gsynchro/
│   └── gsynchro.yml
├── docs/
│   ├── architecture.md
│   └── decisions.md
├── tasks/
│   ├── todo/
│   ├── in-progress/
│   └── done/
└── src/
```

For example, select the project guidance and task files in `.gsynchro/gsynchro.yml`:

```yaml
destination: /absolute/path/to/drive/my-project
debounce: 5
items:
  - "README.md"
  - "AGENTS.md"
  - "docs/**/*.md"
  - "tasks/**/*.md"
```

`src/` is intentionally not selected: this tool is designed for a controlled set of documentation and task files, not for synchronizing the source tree. The local agent works directly in the repository source tree.

### Task file example

First discuss and approve the intended change in your chatbot, then save or export the approved task as a Markdown file under the Drive folder's `tasks/todo/` directory. For example, create `tasks/todo/TASK-042-add-health-endpoint.md`:

```markdown
---
id: TASK-042
status: todo
created: 2026-09-19
---

# Add a health endpoint

## Objective

Add `GET /health` to report whether the service is ready to accept requests.

## Context

Follow the service structure and conventions documented in `docs/architecture.md`.

## Acceptance criteria

- Return HTTP 200 and `{"status":"ok"}` when the service is ready.
- Add or update the relevant automated checks.
- Do not add a new runtime dependency.
- Summarize the implementation and verification in this task file.
```

The intended handoff is:

```text
ChatGPT Project
  └─ design, architecture, approved task
       ↓ save task Markdown in the linked Drive folder
Google Drive folder
       ↓ local client makes files available
gsynchro
       ↓ copies tasks/todo/TASK-042-*.md into the repository
Local task runner
       ↓ sees a stable todo file and claims it once
Coding agent
       ├─ reads repository guidance and task acceptance criteria
       ├─ works in the local source tree
       └─ writes a result and task status update
gsynchro
       └─ copies the updated task and selected documentation back to Drive
```

### Local runner responsibilities

The runner is a separate component that must be installed and kept running on the development machine. A typical runner should:

- watch only `tasks/todo/*.md`, rather than launching work for every filesystem event;
- wait until a new or changed task file is stable before reading it;
- accept only tasks with a unique ID and `status: todo`;
- claim a task atomically or keep a durable run record to prevent duplicate execution;
- start the coding agent in the intended repository and pass the task file and project instructions;
- record `in-progress`, `done`, or `blocked` plus a short outcome in the task file or a run log;
- handle restart and failure cases without silently losing a task.

The runner may move a task through `todo/`, `in-progress/`, and `done/`, or update its status in place. Choose one convention and use it consistently. If it changes a synchronized file on the repository side while a different edit is made to the same path in Drive, the repository version wins under `gsynchro`'s conflict rule.

### Example project instructions for a chatbot

Instructions configured in a chatbot project or workspace can keep design discussions and task handoffs consistent. For example:

```text
Use the linked project documentation and decisions as the source of truth.
Help me clarify requirements and architecture before proposing implementation tasks.
When I approve a task, produce a Markdown task file with a unique ID, status,
objective, context, constraints, and testable acceptance criteria. Target
tasks/todo/ and do not claim that code has been changed or verified.
```

The chatbot produces the task content; saving it as a `.md` file in the Drive inbox is the handoff that the runner can observe. The connected Drive source and the local filesystem watcher serve different roles.


`gsynchro` works with local filesystems. It does not connect to Google Drive or use Google APIs; authentication, local availability, and remote caching are managed by the Google Drive client or filesystem mount tool.

## Features

- Watches the project and destination directories and reconciles selected files after a configurable quiet period.
- Copies new and changed files in either direction.
- Propagates deletions using a saved synchronization state.
- Resolves simultaneous changes in favor of the project directory.
- Moves propagated deletions to a local `.trash/` directory where possible.
- Restricts synchronization to `.md`, `.txt`, and `.json` files up to 10 MiB.
- Supports glob patterns relative to the project root.

## Requirements

- Node.js 20 or later.
- A destination directory that exists and is accessible before `gsynchro` starts.
- If synchronizing a cloud drive, a working local mount managed separately, such as rclone.

## Installation

Install `gsynchro` as a development dependency in the project you want to synchronize:

```bash
npm install --save-dev gsynchro
```

Add a script to your project's `package.json`:

```json
{
  "scripts": {
    "gsynchro": "gsynchro"
  }
}
```

Create the configuration file described below, then run the watcher from the project root:

```bash
npm run gsynchro
```

The process stays active while it watches both directories. Stop it with `Ctrl+C` or a termination signal.

## Configuration

Create `.gsynchro/gsynchro.yml` in the project root:

```yaml
# Existing local directory or mount point for the other side of the sync.
destination: /home/alex/Drive/projects/my-project

# Seconds of inactivity before reconciling filesystem changes.
debounce: 5

# Glob patterns relative to the project root.
items:
  - "*.md"
  - "docs/**/*.md"
  - "handbook/**/*.md"
  - "metadata/**/*.json"
```

### Configuration fields

| Field | Required | Description |
| --- | --- | --- |
| `destination` | Yes | Path to the existing destination directory. Relative paths are resolved from the process working directory; an absolute path is recommended. |
| `items` | Yes | A non-empty list of glob patterns, relative to the project root, that selects files for synchronization. |
| `debounce` | No | Quiet period in seconds before a reconciliation. Defaults to `3`; `0` runs without an additional delay. |

Patterns are evaluated against both roots. For example, `docs/**/*.md` selects Markdown files below `docs/` on both sides. Files still need to pass the fixed safety rules described below.

### Platform setup examples

The `gsynchro` configuration format and npm commands are the same on Windows, Linux, and macOS. Only the destination path and the way the remote directory is mounted differ. In each example, mount the remote first, set `destination` to a project-specific directory inside the mount, and start `gsynchro` from the project root.

The destination directory must already exist. `gsynchro` deliberately does not create it: if the mount is unavailable, creating the mount point as an ordinary local directory could lead to changes being written to the wrong place. Keep the project root and destination as separate directories that do not contain one another.

#### Windows: Google Drive for desktop

On Windows, the simplest setup for Google Drive is the official [Google Drive for desktop](https://www.google.com/drive/download/) client. After signing in, it makes My Drive available in File Explorer. In streaming mode it appears as a virtual drive (usually `G:`, though the drive letter can be changed); in mirroring mode My Drive is stored in a local folder. See Google's guide to [streaming and mirroring](https://support.google.com/drive/answer/13401938?hl=en) for setup details.

For predictable local file access, use **Mirror files**, or keep the specific project folder available offline when using **Stream files**. Streaming saves disk space, but files may need to be downloaded when accessed and require Drive for desktop to be running. `gsynchro` reads selected files to calculate hashes, so the client must be able to provide their contents.

In File Explorer, find the exact path to My Drive and create a project-specific destination folder inside it. For example, if My Drive is shown under `G:`:

```powershell
New-Item -ItemType Directory -Force 'G:\My Drive\projects\my-project'
```

Use that path in `.gsynchro/gsynchro.yml`. Forward slashes work in YAML on Windows:

```yaml
destination: 'G:/My Drive/projects/my-project'
debounce: 5
items:
  - "*.md"
  - "docs/**/*.md"
```

If you use mirroring, set `destination` to the corresponding local folder selected in Drive for desktop preferences, for example `C:/Users/Alex/My Drive/projects/my-project`. The exact drive letter and folder layout depend on your Drive for desktop settings.

Start the watcher from the project root in PowerShell:

```powershell
Set-Location C:\work\my-project
npm run gsynchro
```

Keep Drive for desktop running and signed in. Wait for it to finish uploading local changes before shutting down or disconnecting the computer.

#### Linux

Create an existing local mount point and mount the rclone remote there:

```bash
mkdir -p "$HOME/GDrive"
rclone mount gdrive: "$HOME/GDrive" --vfs-cache-mode writes
```

In another terminal, create a project-specific directory inside the mount and point the configuration at it:

```bash
mkdir -p "$HOME/GDrive/projects/my-project"
```

```yaml
destination: /home/alex/GDrive/projects/my-project
debounce: 5
items:
  - "*.md"
  - "docs/**/*.md"
```

Start `gsynchro` from the project root in another terminal:

```bash
cd ~/work/my-project
npm run gsynchro
```

The required FUSE support and permissions depend on the Linux distribution and mount configuration. Consult the [rclone mount documentation](https://rclone.org/commands/rclone_mount/) if the mount command fails.

#### macOS: Google Drive for desktop

On macOS, the official [Google Drive for desktop](https://www.google.com/drive/download/) client is a practical option. It exposes Drive in Finder and supports both streaming and mirroring. Google's [macOS guide](https://support.google.com/drive/answer/12178485?hl=en) describes the setup and permissions.

For the most predictable access from `gsynchro`, select **Mirror files** in Drive for desktop preferences. Mirroring stores My Drive in a regular local folder and keeps it available offline. Choose or note the mirrored folder location in Drive preferences, then create a project-specific subfolder there:

```bash
mkdir -p "$HOME/Google Drive/projects/my-project"
```

Set `destination` to the actual path you selected. For example:

```yaml
destination: '/Users/alex/Google Drive/projects/my-project'
debounce: 5
items:
  - "*.md"
  - "docs/**/*.md"
```

If you prefer **Stream files**, first locate Google Drive in Finder under **Locations** and use the path shown there. On macOS 12.1 and later, streaming uses Apple's File Provider; Google documents `~/Library/CloudStorage` as the default location, and macOS may control the folder location. On the legacy streaming method, the default is `/Volumes/GoogleDrive`. These paths can vary with macOS version and Drive settings, so inspect the actual location rather than copying either default blindly. Make the project folder available offline before running `gsynchro`; streaming files may otherwise need to be downloaded when read.

Use the verified absolute path to that folder as `destination`; do not copy a generic File Provider path because the folder name and location can vary. If Drive cannot access the chosen folder or an external volume, review its macOS privacy permissions in System Settings.

Start the watcher from the project root in Terminal:

```bash
cd ~/work/my-project
npm run gsynchro
```

Keep Drive for desktop running and signed in, and wait for local changes to finish syncing before shutting down. See Google's guides to [streaming and mirroring](https://support.google.com/drive/answer/13401938?hl=en) and [customizing Drive locations](https://support.google.com/drive/answer/13470231?hl=en) for current settings.

## Running and diagnostics

Start the watcher from the project root:

```bash
npm run gsynchro
```

Enable detailed watcher and reconciliation logs with:

```bash
npm run gsynchro -- --debug
```

Debug output includes timestamps and filesystem events, filter decisions, debounce activity, and the reconciliation plan. The watcher uses polling for the destination directory to improve change detection on mounted filesystems. Remote changes become visible according to the mount client's cache behavior; `gsynchro` cannot detect a remote change before the mounted filesystem reports it.

## Synchronization behavior

`gsynchro` treats filesystem events as a signal to rescan both roots. It compares SHA-256 file hashes with the last saved common state, builds a reconciliation plan, applies the plan, rescans to verify the result, and only then saves the new state. Re-running reconciliation without external changes should not produce additional file operations.

### Initial run

On the first run, there is no previous state to compare against:

- A selected file present only in the project is copied to the destination.
- A selected file present only in the destination is copied to the project.
- If the same path exists on both sides with different contents, the project copy wins.
- If both copies already match, no copy is needed.

Review the configured patterns and destination before the first run, especially if both locations already contain files with the same paths.

### Changes and conflicts

After the first successful reconciliation, `gsynchro` uses the saved common hash to determine which side changed:

| Project | Destination | Result |
| --- | --- | --- |
| Changed | Unchanged | Copy project file to destination |
| Unchanged | Changed | Copy destination file to project |
| Changed | Changed | Project file wins and is copied to destination |
| Deleted | Unchanged | Move destination file to its `.trash/`, if possible |
| Unchanged | Deleted | Move project file to its `.trash/`, if possible |
| Deleted | Changed | Project deletion wins; move destination file to its `.trash/`, if possible |

The project directory always wins a conflict, including a conflict between a project-side deletion and a destination-side edit.

### Deletions and trash

When a deletion is propagated, `gsynchro` attempts to move the affected file into `.trash/` on the side where the file is being removed. The two trash directories are independent and are never synchronized. Trash is a recovery aid; synchronization decisions are based on the saved status file, not on trash contents.

## Safety rules

The following rules are always applied, regardless of the configured patterns:

- Only `.md`, `.txt`, and `.json` files are eligible; extension matching is case-insensitive.
- Files larger than 10 MiB are skipped.
- `.git/`, `node_modules/`, `.gsynchro/`, and `.trash/` directories are excluded.
- Symbolic links are not followed or synchronized.
- The project root and destination cannot be the same directory or contain one another.
- Both roots are validated before missing files can be interpreted as deletions.
- Files outside the eligible set are invisible to synchronization and are not treated as deleted.

## State and Git ignore

`.gsynchro/gsynchro.status` is created automatically after a successful reconciliation. It stores the hashes and presence state needed to distinguish a deletion from a file that has never been synchronized. Do not edit or commit it.

Add the generated state file to the project's `.gitignore`:

```gitignore
.gsynchro/gsynchro.status
.gsynchro/gsynchro.status.tmp
```

Keep the status file between runs. Removing it resets synchronization history; the next run is treated as an initial synchronization and may replace different destination content with the project version when paths overlap.

## Troubleshooting

### `destination` does not exist or cannot be accessed

Start or repair the filesystem mount and confirm that the configured directory exists and is readable and writable by the current user. `gsynchro` will not create the destination directory.

### A file is not synchronized

Check that its path matches an `items` pattern, its extension is `.md`, `.txt`, or `.json`, it is no larger than 10 MiB, and it is not inside an excluded directory. Run with `--debug` to inspect watcher and filter output.

### Remote changes appear late

The destination watcher polls the mounted filesystem, but remote visibility depends on the mount client's cache and refresh behavior. Check the rclone mount and its cache configuration.

### A conflict was resolved unexpectedly

The project directory wins simultaneous changes. Check `.gsynchro/gsynchro.status` is present and has not been reset; it is the baseline used to tell which side changed.

## Development

Clone the repository, then install dependencies and build:

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```

The published package includes the compiled CLI, this README, and the license. To publish a release, update the version in `package.json`, build the package, and publish it from an npm account with access:

```bash
npm run build
npm publish
```

## License

MIT. See [LICENSE](LICENSE).
