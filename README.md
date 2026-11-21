# M365 Code Agent

[English](README.md) | [한국어](README.ko.md)

**Experimental preview · Unofficial · Windows + Microsoft Edge**

An independent VS Code coding agent that uses your signed-in Microsoft 365 Copilot web session through Playwright. Read, search, create, edit and delete workspace files without a browser extension, clipboard relay or separate AI API key.

This project is not affiliated with, endorsed by, or supported by Microsoft. You need an eligible Microsoft 365 Copilot account and permission to use browser automation in your organization. Successful tests with one account and example projects do not establish compatibility with every tenant, login flow or security policy.

Version **0.16.2** adds native image, PDF, Word and Excel uploads plus sampled video-frame analysis in the M365 Agent sidebar. Both prompt budgets now default to 120,000 characters. It retains mapped conversations, the optional model provider and existing Webview protections. See the [changelog](CHANGELOG.md).

## Authentication and change protection

- **No separate extraction or relay of access tokens or cookies.** Sign in and complete MFA yourself in a dedicated browser. Its profile retains the session.
- **The extension does not open a separate localhost HTTP server.** It automates the web UI and does not call private Copilot APIs directly.
- **The existing Webview file tools verify SHA-256 hashes and previously read ranges.** They provide change review and undo. Explicit automatic approval also skips execution-config review and command approval; shell changes are outside file-tool protection and undo.

Code, conversation context and tool results needed for a task are sent to the signed-in M365 Copilot website. These design choices do not imply organizational approval or Microsoft support. Filename filters cannot identify every secret; configure sensitive paths in `.m365agentignore`.

## Install and connect

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jhoon-dev.m365-code-agent), or use **Extensions → … → Install from VSIX…** with `m365-code-agent-0.16.2.vsix` from a [GitHub release](https://github.com/jhoon-dev/m365-code-agent/releases).
2. Open a local project and click the **M365 Agent** icon in the left Activity Bar or the editor title toolbar. The command `M365 Agent: 열기` also opens/restores this view in the secondary sidebar.
3. Click **연결** (Connect) below the input. The **M365 Copilot 브라우저** editor tab displays the actual automated Edge page.
4. Complete your company login and MFA yourself, then open the Copilot chat page. Use **외부 브라우저로 전환** (Switch to external browser) if native authentication windows are needed.
5. Enter a request in VS Code and press Enter or the send arrow. Shift+Enter inserts a newline. Subsequent submission and response collection are automatic.

Requires Windows, VS Code 1.106+ and Microsoft Edge. No separate Python or Node.js installation is needed to run the extension, although your project's build/test commands need their own runtimes. Remote WSL/SSH/container workspaces are outside this release's scope. In a multi-root workspace, select one local project folder.

The extension does not import your normal Edge profile or passwords. The Webview uses its own persistent profile. Login expiry, MFA and CAPTCHA require your direct action. The extension UI and activity messages remain Korean; model answers default to your request's language and follow an explicit response-language instruction.

## Experimental VS Code model provider

**Optional and disabled by default.** This runs alongside the existing Webview and exposes **M365 Web (Experimental)** in the host's model picker. It uses the model currently selected on the website, without claiming a particular model identity or native context window.

1. Enable the user-level setting `m365Agent.experimental.modelProvider.enabled`. Workspace settings cannot enable it.
2. Copy the [compact Agent template](examples/m365-web.agent.md) to your project's `.github/agents/m365-web.agent.md`.
3. In Copilot Chat, choose **M365 Web** as the Agent and **M365 Web (Experimental)** as the model under **M365 Code Agent (Experimental)**.
4. On the first request, complete login/MFA in the provider's **separate dedicated external browser**. It does not copy the Webview profile or cookies.
5. Start with a short question and the template's `read`/`edit` tools. Host Chat availability, account access, tools and organization policy still apply.

The template requests file reading/editing without terminal commands or external services; it is not a security sandbox. The default Agent with all extension/MCP tools can exceed the host's System/tool context budget **before the provider is called**. Browser-side compaction cannot fix that preflight failure. Use a new Chat with a compact Agent or only the necessary tools. The `Local` and `Copilot` execution paths differ; changing the model does not switch the execution path.

| Path | Tool execution and approval | Change protection and undo |
| --- | --- | --- |
| Existing M365 Agent Webview | Extension file/command approval and lookup MCP policy | File-tool hashes, read ranges and undo; shell and remote-tool effects excluded |
| Experimental model provider | Returns host tool calls to VS Code; the host/calling extension executes and approves them | Host/tool protections apply. **Webview hash/range validation and undo do not apply** |

### Limits and conversation handling

- Converts text, System/User/Assistant roles, tool schemas, call IDs and results. System instructions are preserved as roles and bridge instructions in JSON; this is not access to the website's native system channel. UTF-8 text/JSON/XML DataParts and documented text-only PromptTsx trees are supported. Images, binary data and opaque/unknown PromptTsx nodes are explicitly rejected.
- Keeps a separate browser profile and a serial queue of up to eight active/pending requests. Queued cancellation submits nothing. Each VS Code Chat starts one web conversation on its first request. Follow-ups and tool round trips reuse it; switching Chats restores the corresponding web URL. **Successful browser sessions are reused.** Failure, cancellation, relevant configuration changes or disposal retire the browser. The provider does not synchronize with the Webview's history.
- **Web history is not disabled or automatically deleted.** Each mapped web conversation may retain all round-trip JSON prompts containing conversation context, code and tool results. Organizational retention/audit policy may apply. Local count-only diagnostics do not prevent this web history.
- The [stable VS Code model-provider API does not expose a Chat/session ID](https://github.com/microsoft/vscode/issues/305853). The experimental bridge therefore retains opaque routing references in assistant history and unique host tool-call IDs, with URL mappings saved in workspace state. These reference definitions are hidden by Markdown rendering, but can appear when copying raw text. They are removed from model input; mapping storage contains no prompt/answer bodies. Callers that manage their own sessions may pass `modelOptions.m365ConversationId`. If history identifiers are missing, stale (for example after branching/regeneration), or the saved web URL cannot be restored, the request stops instead of guessing or creating another web conversation. Start a new VS Code Chat when first switching to this provider from another model; older pre-mapping provider Chats cannot be restored automatically.
- Webview chats keep their own existing URL mappings; native Copilot Chat and Webview lists are separate. Web titles, local renames/deletions and rendered web JSON are not mirrored. Existing accumulated web history is left intact.
- No token streaming: validated text and tool calls are returned after the complete JSON response is collected. Web round trips add latency at each Agent step.
- `m365Agent.experimental.modelProvider.maxPromptCharacters` defaults to **120,000 characters**, maximum 120,000, including bridge instructions, history and schemas. This is separate from the Webview's separate 120,000-character default. The actual web input limit takes precedence. Only a **confirmed unsubmitted** length rejection can trigger one smaller rebuild; uncertain submissions are never resent.
- Supports up to eight tool calls per response, without a fixed tool-schema count limit. Calls in one response may run concurrently; the bridge instructs the model to batch only independent actions and request verification reads after edit results in a later response. This does not enforce host execution order.
- On overflow, old assistant/tool exchanges can be omitted at complete boundaries. **All System instructions, all user requests including intermediate restrictions, the latest tool exchange and all schemas remain.** Code and current tool results are not silently cut in the middle.
- Exact repeated user text parts of at least 512 characters can reference their full source within the same request. The first/latest user messages stay unchanged. The public input does not reliably separate user prose from attachments, so arbitrary text/XML sections are not discarded as attachments. Unique attachments and user instructions can still accumulate beyond the limit.
- Compaction metadata states only the methods actually used. **Start a new Chat** if required context exceeds the limit. If the first request fails, use the compact Agent or adjust the provider limit to a value supported by your web input. There is no fixed supported turn count.
- Token counts are approximate: UTF-8 bytes divided by three, rounded up. The advertised input budget uses the same units and reserves bridge overhead. It is conservative for multilingual input; the actual character limit is checked separately. Output tokens are an experimental allowance. The web model's tokenizer and true context/output limits are neither discovered nor enforced.
- The provider validates tool names, IDs, argument objects and required-call mode. Input-schema validation and execution authorization belong to the host/tool. It does not execute local commands, files or MCP tools itself.

Disabling the provider stops its active web response and rejects pending requests. Only provider settings and the URL, browser channel, selectors and login/response timeouts used by it invalidate requests. Webview-only settings such as `browserView` and the Webview's `maxPromptCharacters` do not interrupt provider work.

The **M365 Web Model** output channel records phases, role/message/tool counts, character counts and error codes. It does not log prompts, source text, arguments, responses, tokens or cookies. A host context-budget error with no provider request log indicates a preflight rejection.

### Live-account verification

**Conversation mapping check (November 19, 2026, VS Code 1.147.0):** four successful text requests through the **Local / Ask** path verified A → A follow-up → separate B → reopened A. Both A follow-ups used A's original web URL; B used a different URL, and the synthetic ALPHA/BETA answers stayed separate. The test temporarily used an 80,000-character user limit, then restored it. In this host configuration, the legacy compact Agent still passed 91 tools (about 171K characters); Ask passed 20 tools (about 64K), exceeding the then-default 60K. Tool selection/Agent migration and host configuration therefore still matter. An initial literal-only answer omitted transport JSON; after clarifying text-field versus envelope formatting, the four requests completed. Restart restoration and tool-round-trip mapping are covered by automated tests with real Edge mock pages and native-host typed calls; this live run did not execute tools.

Historical checks before conversation mapping, on **November 18–19, 2026, VS Code 1.147.0**, used a compact read/edit Agent, the **Copilot** execution path and an actual M365 web account:

- Changed a calculator's subtraction bug to addition and completed read → edit → tool-result-based completion. The first run used a 120,000-character setting. After matching token-budget units, separate tasks also worked at the then-default 48,000-character limit.
- A first request needed approximately **46K total characters**: about 39K of messages, 5K of tool schemas and bridge overhead. This is a measurement, not a universal minimum. Smaller web inputs can reject even the compact Agent's first request.
- A concurrent edit/read initially returned pre-edit verification content. After clarifying dependencies in bridge instructions, a separate subtraction-function test completed read → edit → post-edit read → Korean completion over four model requests.
- Tested **five user turns in the same Chat**. At 48,000 characters, turn three saved the edit and read it back, but final completion failed with a minimum required context of **48,370 characters**. Increasing the limit to 60,000 allowed that Chat to continue through turn five. Added `square`, `cube` and `negate`, verified saved files and recalled initial/intermediate restrictions. The final request used about **53.7K total characters**, including roughly 46.9K of messages and 5K of schemas. This measurement informed the then-default 60,000-character limit.
- Outside the Agent, the saved calculator passed 12 arithmetic assertions and a source-preservation check for its three original functions. Live testing exercised old-exchange omission; exact repeated-text references are covered separately by automated tests.

These results do not establish compatibility with the default Agent's full tool set, every MCP configuration, longer conversations or every tenant. **A successful single task does not establish unrestricted multi-turn support.** The full-tool default Agent's context-budget failure was reproduced. No claim of a seven-to-nine-turn ceiling is made; prompt size depends on content and host behavior.

## Webview chat, browser and history

The existing M365 Agent view remains available without enabling the model provider. Use the same input for explanations, plans, reviews and edits. `/ask`, `/plan` and `/review` are read-only; `/agent` explicitly allows ordinary Agent tools without forcing a file change. `/test` is a testing shortcut. Language heuristics are imperfect; default approvals remain in force.

- A request can wait up to ten minutes for login/composer readiness. It resumes once ready. Input may be re-entered only after a confirmed pre-submit reset; an already-clicked send is never automatically clicked again. Failed requests return to the VS Code input without replacing a newer draft.
- **모델 불러오기** (Load models) reads the account's visible web menu. It does not invent models or bypass license restrictions. Use the current web model if no compatible menu is found.
- **＋ 파일** selects up to five workspace files. **이미지·문서·동영상** opens a local file picker, including files outside the workspace. Images, PDF, Word and Excel files use Copilot's native upload UI; ordinary workspace text keeps the existing text-context behavior. **현재 파일** includes the current editor/selection. Initial inspection also searches relevant paths/code and reads up to four ranges at the default budget, fewer at smaller budgets. It does not claim to inspect the whole project.
- **프로젝트 점검** (Project check) tests local reads and creates/reads/removes only a temporary `.m365-agent-check-<id>.tmp` in the project root, without contacting M365 or changing source files. It does not prove every file is writable.
- Local history retains the latest 20 conversations per workspace. Search, rename and delete affect local records only, with deletion confirmation. Project files and web originals remain. History switching/new Chat reuses the tab and refuses to overwrite a web draft or interrupt ongoing generation.
- Local conversations map to their web URLs. While the view is visible and idle, current rendered web messages synchronize every five seconds; **웹 대화 동기화** triggers this manually. Imported JSON never executes file/command actions. Old in-flight sync cannot override a newer history selection or task.
- Synchronization is limited to messages rendered in the connected tab. It does not download every web conversation, upload all old local history or propagate deletions. Web virtualization may omit older messages.

### Images, documents and video analysis

Select **이미지·문서·동영상**, choose files and ask, for example, “Compare the spreadsheet with the PDF” or “Explain the error visible in this recording.” Supported native uploads include PNG/JPEG/GIF/BMP/WebP images, PDF, Word (`.doc`, `.docx`) and Excel (`.xls`, `.xlsx`). Copilot must accept the selected format in your account. Its [supported-format guidance](https://support.microsoft.com/en-us/microsoft-365-copilot/file-formats-supported-by-microsoft-365-copilot) and tenant permissions still apply. An upload failure stops the request instead of silently asking without the file.

**Live VS Code check (November 19, 2026, VS Code 1.147.0):** the installed 0.16.0 VSIX was exercised through the actual sidebar file chooser and Run button against one signed-in company Copilot account. Synthetic image/PDF and Word/Excel pairs returned their file-only markers, PDF total 43, Word budget difference 200 and Excel total 87. A synthetic video returned the correct red/FIRST, green/MIDDLE and blue/LAST samples at 0.967, 2.9 and 4.833 seconds, with audio and unsampled-scene limitations. Both upload confirmation and the rendered sidebar answers were checked. This does not establish support for every tenant, policy, codec or file size.

Videos (`.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`) are decoded locally with bundled FFmpeg and represented by three evenly sampled JPEG frames with timestamps. The original video is not uploaded. Analysis covers those sampled images only: it does not transcribe audio, inspect every frame or establish what happened between samples. The request includes this limitation so the model can qualify its answer.

Select at most five files; videos expand into frames, and the resulting native uploads must also fit the five-file cap. Attachment defaults are 64MB per selected file and 100MB total; adjust `attachmentMaxFileSizeMB` / `attachmentMaxTotalSizeMB` if needed. Smaller service limits take precedence. Native file bytes use the upload channel rather than the 120,000-character prompt budget. Existing text attachments retain their separate text-context budget.

Only files you select are uploaded; project inspection does not automatically upload documents or media. Native files and video frames enter your signed-in Microsoft service and are subject to its storage, retention and organizational policies. Attachments are available in the **M365 Agent sidebar**; the experimental VS Code model provider still rejects image/binary API inputs.

If an interrupted upload leaves a pending draft, clear its attachments and refresh the dedicated Copilot page before retrying. Use the attachment selectors below if your tenant renders a different upload interface.

`m365Agent.browserView=editor` displays the actual Playwright page in a VS Code Webview with mouse, scrolling, keyboard and Korean IME support. Input is locked during automated submission/collection/model-menu actions and allowed while waiting for login. A tab selector can show login popups from the same dedicated browser.

Closing the browser editor does not stop automation. Use **⋯ → Copilot 브라우저 열기** to reopen it. Switching to an external browser stops the task and restores its request to the input; log in and resend. For a persistent external window, set `browserView` to `external` and reload. Native passkey/certificate/password-manager flows may require that mode.

The browser view is not an iframe or the experimental BrowserTab API. Frames stay in memory; it does not save screen files, extract cookies/tokens or change web security headers. Capture pauses when hidden, and displayed URLs omit authentication query/fragment data.

Answers support Markdown, code copying and adjustable 12–18px text/wrapping. **크게 보기** opens a reusable read-only answer editor without creating project files. Tool/system activity collapses into groups, failed tools expand and review cards remain visible. New events preserve scroll while reading an older answer. HTML and remote images in answers are not executed/loaded.

Recognized outcome/summary project-report objects embedded in answer text are displayed as readable sections rather than raw JSON, including in saved history. Stored originals remain unchanged; explicit JSON output requests and fenced examples retain their format. Copy and the wide reader use the same displayed text. This is presentation only and never executes report fields as file/tool actions.

## File changes, approval and commands

File tools run in the extension host, not inside the Copilot website. Read source and tool observations enter web prompts; the website receives no direct workspace access.

- **변경 승인** (Review changes) is on by default. Open each file's VS Code diff, then apply or reject. Turning review off automatically applies validated ordinary-file edits, while deletion, execution-config changes and commands still require review/approval.
- Execution/build/CI configuration, setup hooks and shell scripts remain reviewable by default, including `package.json`, `*.config.*`, test initialization, Python test configuration, wrappers and `.cargo/` files. This is not a complete prompt-injection defense.
- Create/full-replace/partial-edit/delete operations are supported. Whole-file replacement requires a complete read. Paged `read_file` ranges use `startLine`, `startColumn`, `lineCount` and continuation coordinates. Partial edits require a unique `oldText` in a previously read range with the current hash. Stale hashes, unread ranges, duplicate anchors and overlapping edits are rejected.
- Unsaved user changes are not overwritten. Results arriving after Stop are not applied; changes already saved remain. Completion reports the actual applied-file count, including zero; a prose claim is not proof of an edit.
- Undo restores the last file-change batch, removes created files and restores deleted bytes. It refuses to overwrite subsequent edits or recreated paths. Up to 20 batches remain in memory during the current extension session; restart loses this undo. Shell/MCP effects are excluded.
- Default command execution shows the exact command and working directory and requires approval every time. It runs with your user privileges, without a sandbox, and can affect paths outside the project. Commands have a 120-second timeout, cancellation and bounded output. The **M365 Code Agent** output channel shows actual command output.
- Commands run in a background shell: `ComSpec` (normally `cmd.exe`) on Windows, `/bin/sh` elsewhere. They do not inherit a selected VS Code terminal's PowerShell, virtual environment or current directory. Explicitly invoke another installed interpreter when needed.

**승인 없이 진행** (Proceed without approval) is a separate, explicitly selected option, off by default. It automatically approves file changes, execution-config review and terminal commands for that task. File-tool path, secret-name, hash, range, dirty-file and read-only checks remain. Shell commands are outside those protections and undo, including commands invoked by changed configuration. File-tool deletion guidance does not forcibly block shell deletion commands.

**요청 횟수 무제한** (Unlimited requests) independently removes the extension's round-count ceiling for that task. The normal default is 100 requests, configurable up to 500. Both options are frozen at task start and remain visible when controls collapse. Unlimited requests do not remove approval, repetition detection, Stop, completion/error termination or file validation. They do not change M365 limits or authentication.

The extension excludes common generated/dependency/virtual-environment paths, `.git`, `.env*`, keys/certificates, `.npmrc`/`.netrc`, credential/state names and root `.gitignore`/`.m365agentignore` rules. Links/junctions and paths outside the selected project are refused by file tools. Text reads default to 16MB, configurable to 128MB. A change batch allows up to 30 operations and 512KB of proposed content; partial edits count replacement strings rather than the entire source file. UTF-8 and BOM-marked UTF-16 are supported, with open-editor text available for other encodings.

Failed proposals trigger targeted rereads and correction using real hashes. Task IDs, executed tools, applied files and recent errors carry into follow-up requests. Repeated unchanged reads, errors, proposals or command outcomes stop unproductive loops; a genuinely new range, source change or rerun after a source change is new evidence. This does not guarantee recovery or justify applying invalid proposals.

### File and folder deletion

Text, binary and empty files are supported. `file_info` checks file bytes/hash; `folder_info` records a full checked tree/hash. Passing a folder to `file_info` does not authorize deletion.

Deletion is marked **D · 삭제** in review cards. Dirty/changed files, ignored or secret paths and links are refused. A folder permits up to 1,000 entries including its root; one excluded entry/link rejects the whole operation. Deleted-byte backups are bounded to 32MB per batch, and per-file size limits still apply.

Folder removal deletes only checked files and then known empty directories; it is not an unrestricted recursive delete. Changed trees or newly added files stop removal. Partial rollback restores missing originals and empty directories without deleting new files or overwriting recreated paths. A partially failed VS Code operation retains backups and stops instead of retrying. Terminal deletions are outside this mechanism.

## Editor actions and diagnostic quick fixes

Select code, right-click **M365 Agent**, then choose explanation, review or an edit instruction. Explanation/review are read-only; canceling the edit instruction submits nothing. The same commands appear in the command palette.

For an error/warning, use the lightbulb or `Ctrl+.` and select **M365 Agent로 수정안 요청: …**. This captures the chosen diagnostic's message, source, code, position and surrounding code. Merely opening the menu performs no request or edit, and the action is not a preferred automatic fix.

Editor requests begin with the target file; related files can be retrieved using tools. Edit/quick-fix requests force change review on, automatic approval off and round limits on, independently of the next sidebar request's options. The existing draft/options are preserved. Proposed changes enter ordinary diff review and undo.

The document version, selection and diagnostic are captured at invocation. Changed source or a removed/changed diagnostic requires a fresh request; moving focus does not retarget the action. Save dirty files before edits. Explanation/review can use the current unsaved selected text. Only trusted local allowed files are accepted, and concurrent tasks are refused. Selections above 10,000 characters provide coordinates instead of silently clipped text, so the model can request ranges.

## Lookup-oriented MCP tools in the Webview

Uses MCP-tagged tools already exposed by VS Code's Language Model Tools API, without importing server credentials/configuration or starting another MCP client. Host server trust, authentication and extra confirmations apply.

1. Connect and start a trusted MCP server with read-only credentials in VS Code.
2. Choose **⋯ → 조회용 MCP 도구 선택** (Select lookup MCP tools), or the corresponding command. Only explicitly selected tools are offered; selection is stored locally per workspace and cannot be enabled by a model response/project settings file.
3. Request an Agent task using those tools. `/ask`, `/plan` and `/review` retain their read-only restrictions and do not invoke MCP.
4. Review the exact tool name/JSON arguments and approve **each** call. Webview automatic approval does not bypass MCP approval. Rejecting or stopping prevents unstarted calls and sends cancellation to started calls.

Only lookup-like names are offered; names indicating writes, deletion, execution or upload are excluded. **This name filter is neither a sandbox nor proof of read-only behavior.** Restrict server permissions themselves. A server's local/remote effects are outside extension diff/undo; returned code/hash/JSON does not grant file-write authority.

Up to 20 tools can be selected. Changed names/descriptions/schemas require reselection; schemas above 5,000 characters are excluded. Arguments allow 12,000 characters, depth 20 and 2,000 entries. Tool lists/results obey context budgets, with `nextOffset` for pagination. Only text results are passed; image/binary/PromptTsx results are omitted with counts. Metadata and returned text are untrusted data and may enter the M365 prompt.

Calls time out after 120 seconds. Timeout leaves the remote outcome unknown and ends the task. Identical rejected/failed calls are not automatically retried within that task. Cancellation cannot guarantee remote rollback; late results do not authorize later file changes.

## Relevant code search

`search_code(query, paths)` ranks code chunks using BM25 plus path matches and returns file/line/column/snippets. It splits common identifier styles and expands selected Korean development terms into English keywords. It is not general semantic search or arbitrary translation. Use `search_text` for literal matching. Both accept relative file/folder scopes and are available in Ask/Plan.

Discovery can cover 20,000 files, respecting root and nested ignore rules, links, secrets and generated outputs. Index limits are 10,000 text files, 256KB per file, 32MB total and 40,000 chunks; traversal limits are 10,000 directories and 100,000 entries. Ranked results cap at 20; literal results at 40 with a 64MB cumulative file budget. Larger files can still be located by path and read in ranges.

`truncated`, scanned/indexed counts and omission reasons expose incomplete coverage. No matches in a partial scan do not establish absence from the entire project. The memory-only index checks file lists/size/mtime on later searches; it does not inspect editor buffers or grant edit authority. Actual edits still require a read and current hash. Only budgeted results enter the prompt, not the whole index.

## Settings and troubleshooting

An existing company Code Assistant web URL can be set in `m365Agent.copilotUrl`; ordinary M365 Copilot chat also works because each request includes protocol instructions. Reload after changing Webview connection settings. Existing web drafts are not overwritten.

| Setting | Default / purpose |
| --- | --- |
| `m365Agent.experimental.modelProvider.enabled` | `false`; user-level model-provider opt-in |
| `m365Agent.experimental.modelProvider.maxPromptCharacters` | `120000`; separate provider transport budget |
| `m365Agent.copilotUrl` | Copilot website URL; optional company-agent URL |
| `m365Agent.browserView` | `editor`; `external` opens a separate browser window |
| `m365Agent.browserChannel` | `msedge`; `chrome` is selectable |
| `m365Agent.composerSelector` | Automatic composer detection; CSS override |
| `m365Agent.sendButtonSelector` | Automatic send-button detection; CSS override |
| `m365Agent.responseSelector` | Automatic response-container detection; CSS override |
| `m365Agent.modelButtonSelector` | Automatic visible model-menu detection; CSS override |
| `m365Agent.responseTimeoutSeconds` | `240` seconds |
| `m365Agent.loginTimeoutSeconds` | `600` seconds |
| `m365Agent.maxRounds` | `100`, up to `500`; existing user settings are retained |
| `m365Agent.attachmentMaxFileSizeMB` | `64`; maximum size of each explicitly selected native attachment/video |
| `m365Agent.attachmentMaxTotalSizeMB` | `100`; total explicitly selected attachment size |
| `m365Agent.attachmentTimeoutSeconds` | `120`; native upload readiness timeout |
| `m365Agent.attachmentInputSelector` / `attachmentButtonSelector` | Automatic native file input/upload-button detection; CSS overrides |
| `m365Agent.attachmentReadySelector` / `attachmentErrorSelector` | Automatic uploaded-file/error detection; CSS overrides |
| `m365Agent.attachmentScopeSelector` | Optional CSS selector for the composer area containing attachment cards and upload status; exclude conversation history |
| `m365Agent.maxFileSizeMB` | `16`, up to `128`; deletion backups have a separate 32MB batch limit |
| `m365Agent.maxPromptCharacters` | `120000`; Webview transport budget |
| `m365Agent.commandOutputEncoding` | `utf8`; `cp949` is available for tools that require it |

For provider context errors, start a **new Chat** first. If its first request fails, reduce tools/attachments or choose a supported limit. Do not infer a token-context size from a character limit. Increasing the setting cannot expand a smaller web input.

**⋯ → 연결 진단** (Connection diagnostics) works even if the browser never opens. The **M365 Code Agent** output channel reports versions, selected channel/view, standard browser-install detection, a temporary profile write probe, failure stage and recent send state without relaunching the browser. Reported storage paths and URL query/fragment values are redacted.

- `PROFILE_ACCESS_FAILED`: check extension-storage permissions and disk space.
- `BROWSER_NOT_FOUND`: check the selected browser installation. `PROFILE_IN_USE`: close another extension connection using that dedicated profile.
- `BROWSER_PANEL_FAILED`: reload or try `browserView=external`.
- `BROWSER_CERTIFICATE_FAILED` / `BROWSER_PROXY_FAILED`: check corporate certificate/proxy/VPN setup and ordinary M365 access.
- `BROWSER_NAVIGATION_TIMEOUT` / `BROWSER_NAVIGATION_FAILED`: inspect page loading and reconnect.

Reconnect reuses live contexts and surviving login/composer tabs. Recovery does not delete profiles/cookies, bypass certificates or change organizational security policy. Missing a standard executable path does not prove a custom installation is absent.

Only structured JSON with the current request ID is accepted. Equivalent blocks are deduplicated, compatible edits merged and persistent same-file conflicts rejected. Mixed tool/edit replies execute tools first and require fresh results before edits. Input text and meaningful whitespace are verified before sending; an uncertain send is never retried. A recognizable legacy automation draft can be recovered, but ordinary drafts are not deleted. Do not manually resend a stopped automation prompt without checking the error.

This unofficial web automation depends on DOM structure, service limits, login state and organizational policies. It is not an official M365 desktop/API integration. Microsoft's contractual data protections do not constitute approval for this extension or guarantee propagation of source-file sensitivity labels to pasted prompts. See [Microsoft's enterprise data protection guidance](https://learn.microsoft.com/en-us/copilot/plan/enterprise-data-protection).

## Development and validation

```powershell
npm ci
npm run check
npm test
npm run test:integration
npm run package
```

`check` runs ESLint, Prettier and JSDoc/TypeScript contract checks against the minimum supported VS Code API types. Runtime code remains CommonJS JavaScript; not every UI module is fully type-checked. `npm run format` formats runtime code and development scripts.

Browser tests use real Edge against local mock Copilot pages, with file-level concurrency limited to two. Integration tests run an actual VS Code extension host for files, approvals, dirty-file/race guards, MCP APIs and model-provider registration/tool round trips. CI runs these checks and packaging. Set `M365_AGENT_VSCODE_PATH` to use a particular local VS Code executable.

Live-account tests are distinct from these mocks/host tests. The model-provider measurements above used one account and an example project. A separate November 16, 2026 Webview check with version 0.13.2 verified manual login, project analysis and reviewed two-file edits; test execution required additional tool-protocol guidance. Not every action succeeded on the first request. These checks do not validate every organization's SSO/MFA/DLP/proxy setup or all revised Webview prompts.

Test-output cleanup is **dry-run by default**:

```powershell
npm run clean:test-output
npm run clean:test-output -- --apply --keep=3 --older-than-hours=24
```

Only completed older `.test-output/integration-*` runs with verified ownership are candidates. The newest three, runs younger than 24 hours, active runs and unknown/link/junction paths are retained. Each candidate is revalidated before removal. Project code, release files, Copilot login profiles and parent-directory browser records are outside the cleanup scope. Fixtures use canonical OS temporary paths and test Windows drive-letter casing and ownership changes.

Packaging rejects test outputs, browser profiles, credential paths and tracked test profiles. Source ZIPs are generated from `git archive`, not by compressing the working folder. Release documentation defaults to English; [한국어 README](README.ko.md) and `INSTALL.ko.txt` are optional alternatives.

References: [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [VS Code Webviews](https://code.visualstudio.com/api/extension-guides/webview), [VSIX packaging and publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
