# Alternative AI and storage scenarios

`gsynchro` is deliberately independent of a chatbot or storage vendor. It synchronizes selected files between a repository and a local directory; a desktop sync client, a filesystem mount, or another local storage mechanism makes that directory available. The ChatGPT Project + Google Drive workflow described in the README is therefore one deployment pattern, not an exclusive architecture.

This document outlines alternatives that provide a similar separation between durable project knowledge, a conversational AI workspace, and an implementation environment. Product plans, file limits, connector permissions, and rollout availability change frequently; use the linked vendor documentation as the source of truth before adopting a workflow.

## At a glance

| Option | Best fit | Freshness model | Write path | Relationship to gsynchro |
| --- | --- | --- | --- | --- |
| Microsoft Copilot Notebooks + OneDrive/SharePoint | Microsoft 365 organizations | References stay current | Use Microsoft 365 or a separate local sync mechanism | Use a OneDrive/SharePoint-synced local folder as `destination` where appropriate |
| Perplexity Spaces + file connectors | Research over connected business files | Connector-dependent | Connectors are primarily for search and retrieval | Use a separate authoring and sync path for task files |
| Mistral Le Chat + Libraries/MCP | Teams needing managed or custom connectors | Libraries are uploaded; MCP behavior depends on the server | MCP server capabilities define actions | A filesystem or storage MCP server can complement gsynchro |
| Gemini Notebook + Google Drive | Google-native, source-grounded research | Drive imports refresh automatically | Read-only for original Drive files | Use gsynchro separately when repository files must return to Drive |
| Claude Projects + connectors | Project work with connected Google Workspace data | Google Docs can sync from Drive | Some creation/export actions require enabled features | Use a local Drive folder for repository handoffs where needed |
| AnythingLLM | Local-first document workspaces and agents | Ingested document knowledge; configure refresh separately | Controlled filesystem skills, agents, or MCP servers | A strong self-hosted conversational layer alongside gsynchro |
| Open WebUI + oikb | Self-hosted, storage-agnostic deployments | Incremental scheduled, webhook, or watch sync | Add an approved tool or MCP server for writes | Can replace the conversational knowledge layer while gsynchro remains the repo bridge |
| LM Studio | Local model serving and MCP | Per-chat document attachment/RAG | MCP server capabilities define actions | Use as an inference backend, not as the synchronization layer |
| Unsloth | Local inference and model fine-tuning | No project knowledge synchronization layer | Tool and API capabilities depend on the chosen setup | Use to create or serve a specialized model, not to replace gsynchro |

## Microsoft Copilot Notebooks + OneDrive/SharePoint

Microsoft Copilot Notebooks is the closest managed equivalent to a project-scoped conversational workspace for organizations already using Microsoft 365. A notebook can use files, folders, document libraries, and SharePoint sites as references, and supports custom instructions. References remain current as the underlying content changes. Microsoft states that a Microsoft 365 Copilot notebook can hold more than 300 references, but only the first 300 are used for grounding; Copilot Chat notebooks have a lower limit. [Microsoft’s reference documentation](https://support.microsoft.com/en-us/Microsoft-365-Copilot/add-references-to-your-microsoft-365-copilot-notebook) covers licensing, supported references, and limits.

For this project, the natural storage pairing is OneDrive or SharePoint rather than Google Drive. The notebook is the planning and knowledge surface; a local OneDrive sync client, network share, or other local representation can provide the directory that `gsynchro` needs. Validate the organization’s permissions and retention policies before using shared notebook references.

## Perplexity Spaces + file connectors

Perplexity Spaces provides a project area with custom instructions and attached files. Its Enterprise connectors cover Google Drive, OneDrive, SharePoint, Dropbox, and Box, and are designed for searching, reading, and summarizing connected files. [Perplexity’s connector overview](https://www.perplexity.ai/enterprise/videos/connecting-your-data-how-to-ingest-google-drive-sp-onedrive-box) and [Spaces guide](https://www.perplexity.ai/enterprise/videos/how-to-set-custom-files-and-links) describe the available services and the per-Space attachment limits.

Treat this as a retrieval layer, not as the authoritative writer of task files. Connector licensing, indexing behavior, and limits vary by Enterprise plan and service. If a task or governance document must travel back to the repository, maintain an explicit authoring path in the storage system and use `gsynchro` or another local synchronization mechanism to deliver it.

## Mistral Le Chat: Libraries and MCP connectors

Mistral Libraries are persistent, uploaded knowledge bases that can be attached to tasks. For connected services and actions, Mistral provides MCP connectors, including custom MCP-compatible servers. A connector’s ability to read, create, modify, or delete data is defined by the tool server and is subject to user approval where required. See [Libraries](https://docs.mistral.ai/vibe/work/libraries), [Connectors](https://docs.mistral.ai/vibe/work/connectors), and [MCP connectors](https://docs.mistral.ai/vibe/work/connectors/mcp-connectors).

This area changed in 2026: Mistral’s older Google Drive and SharePoint Knowledge Connectors used indexed copies and scheduled sync, but the vendor documented their removal at the end of August 2026 in favor of MCP connectors. Do not design a new workflow around the retired connector path. For a custom deployment, a trusted storage or filesystem MCP server can provide the actions required by the conversational layer, while `gsynchro` continues to synchronize the controlled document subset with the repository. Mistral documented that the former indexed connector data was stored in European data centers; confirm current data residency and connector terms for the chosen plan. [Knowledge Connector transition details](https://docs.mistral.ai/vibe/work/connectors/knowledge-connectors)

## Gemini Notebook + Google Drive

Gemini Notebook (previously NotebookLM) is a source-grounded workspace for Google Drive content. Google documents that supported files imported from Drive are automatically refreshed every few minutes, and that source access and deletion changes are respected. Gemini Notebook cannot edit or delete the original Drive files, so it is a read-only knowledge path for the source material. [Google’s source documentation](https://support.google.com/gemininotebook/answer/16215270) lists supported formats, source limits, and synchronization behavior.

This is well suited to product discovery, requirements discussion, and review of current Drive documentation. It does not replace a deliberate write-back workflow: save an approved task to Drive through another mechanism, then let the Drive client or mount and `gsynchro` bring it into the repository.

## Claude Projects + connectors

Claude Projects provide project-level instructions and knowledge, while connectors can add data from external services. Anthropic documents that Google Drive files can be added to private projects and that Google Docs added in this way sync from Drive. It also documents saving Claude-generated files to Drive when the necessary file-creation and code-execution features are enabled. These capabilities and restrictions differ between private and shared projects. [Claude’s Google Workspace connector guide](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) is the current reference.

Use the storage permissions and connector scope as the security boundary. When a repository needs a local, reviewable task handoff, continue to use a project-specific local Drive directory and `gsynchro`; do not assume that a connector write has also created a local filesystem event.

## AnythingLLM

AnythingLLM is a local-first application that combines project-like workspaces, document ingestion and retrieval, agents, MCP compatibility, and a choice of local or cloud models. Its desktop application is available for macOS, Windows, and Linux; its self-hosted deployment adds multi-user controls. This makes it a direct alternative to Open WebUI for a private, self-hosted conversational knowledge layer. [AnythingLLM’s product overview](https://anythingllm.com/) and [documentation](https://docs.anythingllm.com/) describe the available workspace, document, agent, and deployment features.

AnythingLLM can give agents filesystem capabilities and supports custom skills and MCP. Treat those as privileged capabilities: restrict them to the intended governance directory, require confirmation for writes, and do not give a model unrestricted access to a repository or home directory. Its document ingestion is not a replacement for `gsynchro`'s explicit bidirectional synchronization, selection rules, conflict policy, and recovery trash. A practical pattern is to use `gsynchro` to maintain the local project-context folder, then let AnythingLLM ingest that controlled folder or access it through a narrowly scoped tool.

## Self-hosted: Open WebUI + oikb

For a self-hosted and storage-agnostic architecture, Open WebUI with its `oikb` companion tool is a strong option. `oikb` incrementally synchronizes a Knowledge Base from local folders, Git repositories, S3-compatible storage, Confluence, Notion, and many other connectors. Its daemon can run on an interval, cron, webhook, or local filesystem watch; it also exposes an OpenAPI tool server through which a model can request a re-sync. [Open WebUI’s oikb documentation](https://docs.openwebui.com/ecosystem/knowledge-base-sync/) lists the current connectors and operational requirements.

`oikb` is a knowledge-base ingestion and refresh mechanism, not a general-purpose governed write-back workflow. If the model must modify source files, give it a narrowly scoped, trusted tool or MCP server and require confirmation for consequential writes. For a repository workflow, `gsynchro` can still synchronize the selected governance and task files between the repository and a local mount such as Nextcloud/WebDAV, rclone, or a network share.

## Local model runtimes: LM Studio and Unsloth

LM Studio runs models locally on macOS, Windows, and Linux, offers a local API compatible with common OpenAI- and Anthropic-style clients, supports document attachment/RAG, and can call MCP servers. It is therefore a good inference backend for AnythingLLM, Open WebUI, or a custom application. Its document feature is chat-oriented rather than a full, automatically synchronized project knowledge base, so it does not replace the storage and synchronization parts of this architecture. Configure authentication before exposing its local API or MCP-enabled server to other devices. See [LM Studio’s application documentation](https://lmstudio.ai/docs/app) and [MCP documentation](https://lmstudio.ai/docs/developer/core/mcp).

Unsloth is primarily a local inference and fine-tuning stack. Its Studio and Desktop products can run models locally and expose OpenAI-compatible APIs, while its fine-tuning tools can specialize a model for a stable task or style. That is useful when retrieval alone is insufficient and there is a maintained training/evaluation process. It is not a substitute for a live project knowledge base: putting changing governance documents into a fine-tune makes updates slower, harder to audit, and harder to reverse than retrieval from the canonical files. A sensible advanced flow is to fine-tune with Unsloth, export the model to LM Studio or another runtime, and retain `gsynchro` plus a knowledge-base layer for current documentation. See [Unsloth’s documentation](https://unsloth.ai/docs) and its [LM Studio deployment guide](https://unsloth.ai/docs/basics/inference-and-deployment/lm-studio).

## Choosing a pattern

- Choose **Copilot Notebooks** when Microsoft 365 and SharePoint/OneDrive are already the organizational system of record.
- Choose **Gemini Notebook** when Google Drive sources need continuously refreshed, read-only analysis.
- Choose **Perplexity Spaces** when connected-file research is the priority and the organization has the required Enterprise connector plan.
- Choose **Mistral** or **Claude** when project context and controlled connector tools are needed; validate each connector’s actual permissions before granting write access.
- Choose **AnythingLLM** when a local-first, integrated workspace/RAG/agent application is preferred over building a stack from separate components.
- Choose **Open WebUI + oikb** when self-hosting, model choice, or non-Google/non-Microsoft storage is a requirement.
- Use **LM Studio** as a local model runtime and MCP client; use **Unsloth** when fine-tuning a local model is a deliberate, evaluated requirement.

In all cases, distinguish three concerns: where the canonical documents live, how the model retrieves them, and how an approved change reaches the repository. A connected source alone does not make a local agent run. `gsynchro` addresses only the last boundary: selected files moving between a repository and an already available local directory.
