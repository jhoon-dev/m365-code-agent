# Changelog

## 0.17.0

- Add English and Korean interfaces across sidebar/browser/response panels, activity, approval flows, notifications and errors. Preserve user/model text, source, browser matching and response-language behavior.
- Add the user-level `m365Agent.language` preference (`auto`, `en`, `ko`). Auto uses the OS locale supplied by VS Code, with platform-locale fallback and English for unsupported languages. Refresh panels on preference changes while preserving drafts, conversations, attachments and pending approvals.
- Localize command/menu names and Settings descriptions through English/Korean VS Code manifest bundles; these host-owned labels follow the VS Code display language.

## 0.16.4

- Fix README language-switch links for Marketplace readers by linking directly to the corresponding repository documents.
- Translate mixed English explanations in the Korean guide, put installation before optional features, and separate historical live-account checks from current release information.
- Refresh packaged documentation and installation version references. Runtime behavior is unchanged from 0.16.3.

## 0.16.3

- Keep identical initial requests in separate web conversations after an anonymous model-provider failure. Discard anonymous failed mappings without a returned routing reference while preserving recovery through explicit conversation IDs.
- Clear selected attachments when switching sidebar conversations, including switches detected through web synchronization.
- Preserve one Undo record for verified text edits, created files and partial folder deletions from the same failed change batch. Protect later user edits, preserve raw-byte disk hashes and stop the agent after a partial change.
- Bound the diff preview cache and evict each before/after pair together.

## 0.16.2

- Keep the Activity Bar shortcut on the left while opening chat in the right secondary sidebar. The editor toolbar opens the same right-side chat.
- Add a separate lightweight launcher so the chat view stays in its own secondary-sidebar container.

## 0.16.1

- Show M365 Agent in the primary sidebar Activity Bar and add an editor title toolbar icon that opens the same chat view.
- Restore the agent view to the primary sidebar when opening it from an older saved layout. Update installation guides and extension-host integration coverage.

## 0.16.0

- Accept legitimate Windows 8.3 file paths while rejecting symbolic links and directory junctions through filesystem-entry checks.
- Recognize native Bebop attachment cards whose filenames exist only in accessibility labels, and distinguish informational OneDrive upload notices from actual failures. Wait for an empty loading composer to settle while preserving existing-draft protection.
- Validate image, PDF, Word, Excel and sampled video analysis through the installed VSIX sidebar/file chooser/Run flow in VS Code 1.147.0 with a signed-in company Copilot account and synthetic fixtures.

- Add explicit local image, PDF, Word and Excel selection and native Copilot uploads to the M365 Agent sidebar, with bounded file sizes, upload readiness/error checks and no silent text-only submission on upload failure. Keep ordinary workspace text attachments and experimental model-provider binary-input restrictions.
- Analyze videos through three locally sampled JPEG frames with timestamps using bundled FFmpeg. State partial visual coverage and no audio transcription in both the request and guides; never upload the original video. Cap selection and resulting uploads at five files.

- Raise the default per-request prompt budget to 120,000 characters for both the Webview agent and experimental VS Code model provider. Preserve explicit user settings and smaller web input limits.

## 0.15.0

- Reuse one mapped web conversation per VS Code Chat across follow-up questions and tool results. Restore its validated URL on Chat switches and after browser/extension restart; never create a replacement when restoration or identity checks fail.
- Route native model-provider Chats using opaque assistant-history references and unique host tool-call IDs because the stable API exposes no session ID. Persist only routing metadata and URLs in workspace state, strip references from model input, and reject mixed/stale/unknown histories. Raw copied Markdown may include the reference. Older pre-mapping provider Chats require a new VS Code Chat.
- Make an unlinked initial Webview chat prepare its own web conversation and prevent it from importing the browser's previously open conversation. Preserve existing Webview URL mappings and draft protection.
- Mark the current request snapshot and tool schemas authoritative when continuing a web conversation. Clarify that task output-format requests apply inside the JSON text field, not in place of the transport envelope. Keep web retention/audit disclosures and English-default/Korean-optional guides. Existing web history is not deleted or renamed.
- Cover text/tool continuity, identical separate Chats, A/B switching, persisted restoration, failed restoration with no fallback, missing/stale routing, storage failures and real Edge draft/navigation behavior.

## 0.14.1

- Fix project-analysis answers appearing as raw JSON in the M365 Agent Webview when the model serialized an outcome/summary report inside an otherwise valid completion message. Render recognized report sections as readable Markdown, including when reopening saved history.
- Preserve stored originals, explicit JSON output requests, fenced examples and unrelated JSON. Keep unknown report fields visible as data and never reinterpret file/tool action envelopes. Copy and wide-view actions use the same displayed answer.
- Clarify that completion messages and change summaries should be user-facing Markdown prose unless JSON output is explicitly requested. Add regression coverage using the reported analysis object and real Edge Webview rendering/copy/reader behavior.

## 0.14.0

- Add an optional, disabled-by-default VS Code language model provider, `M365 Web (Experimental)`, alongside the existing Webview. Bridge typed text/tool messages through a separate dedicated browser profile and return tool calls to the host for execution and approval.
- Reuse successful browser sessions, serialize requests and isolate each turn in a fresh web conversation. Preserve user/System instructions, schemas and the latest tool exchange during compaction; reference exact repeated user text without dropping unique instructions. Use a separately configurable 60,000-character default and approximate token counts in matching units.
- Document actual compact read/edit Agent verification in VS Code 1.147.0: five user turns in one Copilot Chat, a reproduced turn-three failure at 48,000 characters and successful continuation at 60,000. Retain explicit limits for full-tool Agents, accumulated context, web-history retention and response-completion-only delivery.
- Recommend a new Chat first for required-context overflow. Describe only the compaction methods actually applied, and avoid interrupting model requests for Webview-only setting changes. Add regression coverage for policy accuracy, preserved intermediate restrictions and configuration scope.
- Add editor selection explanation/review/edit commands and diagnostic quick fixes. Capture the document/version/range and force review for proposed edits without replacing the next sidebar request's draft or approval settings.
- Add explicitly selected, lookup-oriented MCP tools through VS Code's tools API, with per-call approval even under automatic approval. Preserve host trust/authentication and separate server effects from file diff/undo; name filtering is not a read-only guarantee.
- Add ranked code search, scoped literal search and larger bounded discovery with nested ignores, generated/secret/link exclusions, refreshed memory indexes and explicit incomplete-coverage reporting. Extend paged reads and exact partial edits for large files.
- Keep model diagnostics limited to counts, phases and error codes. Reject browser profiles/test outputs/credential paths during packaging and include all new runtime modules and the compact Agent example.
- Make README, installation instructions and release notes English by default. Preserve optional Korean README/installation guides and keep the existing Korean extension UI.

## 0.13.3

- Advertise `run_command` in the Agent tool list, explain that JSON calls execute in the VS Code host, and provide a command request example. Keep command tools/examples out of read-only prompts and leave approval enforcement in the host.
- Make cleanup fixtures independent of repository output by using canonical OS temporary paths. Exercise lowercase Windows drive input and assert that the ownership-change hook actually ran.
- Clarify automatic approval in the UI and README: execution-config review is also skipped, shell commands run with user privileges outside file-tool protections, and command effects are not covered by file undo.
- Record the limited 0.13.2 live-account example check separately from mock/VS Code tests and the pending live-account recheck of the revised prompt.
- Flush and print VS Code integration output when the host fails. Retain only the explicit integration log/report artifacts under the hidden test-output path so CI failures remain diagnosable.

## 0.13.2

- Keep connection diagnostics available without a browser or a successful launch. Report extension/VS Code/runtime/OS versions, selected channel/view, standard install detection and a temporary profile write probe without retrying startup.
- Catch profile and webview creation failures as well as browser launch failures. Automatically show stage-specific failure codes/details in the output panel; redact profile/storage paths and URL query/fragment data from reported failures.
- Reuse a live persistent context after page loss or navigation failure, retry failed navigation, preserve an existing composer/sign-in page, and prevent an old close event from discarding a newer connection.
- Cover startup classification, offline storage failure, navigation retry, login-page/context reuse, late-close races and actual isolated persistent Edge launch. Verify offline failure diagnostics inside real VS Code.
- Company-PC launch and tenant access must still be confirmed from the reported diagnostic code; do not reset profiles, bypass certificates or change security policies automatically.

## 0.13.1

- Extend JSDoc checking to change application/undo and the agent loop. Enable noImplicitAny, add typed host/transport/approval contracts and check VS Code calls against the minimum supported API types.
- Require original byte buffers in folder restore backups; reject incomplete backup construction before deletion. Add compile-time regression cases for restore data, approval policy and request limits.
- Optimize cleanup: refresh only top-level retention metadata before each deletion, then revalidate the selected tree and ownership. Preserve replaced/active targets and report logical file bytes removed. Test that each candidate tree is visited twice instead of rescanning all trees per deletion.
- Wrap malformed tool-argument JSON in a Korean error while retaining its syntax cause. Split remaining chat/response HTML templates into readable lines.
- Verify full Node tests and actual VS Code integration; keep cleanups restricted to completed integration output, retaining recent runs and links/unknown output.

## 0.13.0

- Make file_info strictly file-only. Folder deletion requires explicit folder_info evidence; host-driven proposal recovery selects and records the matching file/folder tool.
- Validate tool argument field types at the untrusted model boundary. Add JSDoc checking for workspace validation and tool-call normalization, discriminated change/snapshot contracts and negative compile-time fixtures.
- Add pinned Prettier/TypeScript development tools and CI checks. Format runtime modules/scripts, split the protocol prompt and browser HTML into readable sections, and retain byte-identical prompt output across 18 variants.
- Add a dry-run-first test-output cleanup command with retention, completed-run ownership checks, process/age protection, path bounds and link rejection. Mark integration-run lifecycle without touching Copilot sign-in profiles.
- Use an in-memory fixture for the 100+ round policy unit test; retain real filesystem, Edge and VS Code integration coverage.

## 0.12.2

- Restore the unchanged dependency lock entries after a release-version edit incorrectly altered the retry dependency. Only the extension root version changes; clean dependency installation is verified in CI. Runtime functionality is the same as 0.12.1.

## 0.12.1

- Keep file/folder classification host-controlled. Ignore a model-supplied directory flag on ordinary create/edit/replace proposals so valid file changes cannot be skipped as folder-only operations.

## 0.12.0

- Fix transient Copilot control replacement causing `locator.isEnabled` timeouts. Read button state atomically, retry only before dispatch, and collect acknowledgement after uncertain click completion without clicking again.
- Support nested and empty-folder deletion through `folder_info`, complete observed-tree hashes, raw-byte backups and explicit delete actions. Bound each tree to 1,000 entries and deletion backups to 32MB per batch.
- Delete only known files and empty directories through VS Code. Reject excluded children, links, overlapping actions, changed trees and dirty descendants. Preserve partial deletion backups and protect newly added files.
- Restore original bytes and empty folders; refuse recreated paths and replaced partial-deletion roots. Keep normal deletion review and explicit automatic approval independent of request limits.
- Exercise browser DOM races, folder validation, partial failure, UI labels and native VS Code folder deletion/restoration.

## 0.11.0

- Support explicit delete actions for text, binary and empty workspace files, with file_info byte-hash/size inspection and read/hash verification. Reject excluded/secret/link/outside-root paths and directory deletion.
- Show deletions distinctly in file review and command approval. Require review for deletion unless the user explicitly enabled automatic approval.
- Apply deletions through VS Code WorkspaceEdit, support mixed create/edit/delete batches, and restore deleted bytes exactly from in-memory checkpoints without overwriting recreated paths or dirty editors.
- Preserve backups of confirmed deletions if a resource-edit batch partially fails, and stop automatic retries on that partial failure. Bound deletion backup payloads to 32MB per batch, within existing file/count limits.
- Allow metadata-only bootstrap for binary-only projects without claiming source-body analysis; repair missing deletion evidence through file_info.
- Verify binary/UTF-16/empty restoration, rejection/approval, changed/dirty files, collisions and the complete agent deletion flow in real VS Code.

## 0.10.0

- Keep the default 100-request safety ceiling and add a separate, default-off **요청 횟수 무제한** option. Capture and lock the selected limit policy per task; retain it in VS Code view state.
- Make unlimited requests independent of automatic approval, supporting all four combinations. Neither option grants the other.
- Show the current request count with an unlimited label in progress/status and show the selected mode while options are collapsed. Serialize unlimited limits as null with an explicit flag in model progress.
- Retain repeated-work detection, stop, completion/error handling, read-only modes and file validation. Verify more than 100 progressing rounds, repetition termination, cancellation, UI persistence and real VS Code approval isolation.

## 0.9.0

- Raise the default per-task request safety ceiling to 100 (configurable up to 500); retain explicitly configured limits and stop unchanged work before the ceiling.
- Detect repeated identical command outcomes without caching executions. A source change permits the same test command to count as new evidence. Reject identical-content proposals instead of reporting them as applied progress.
- Add an explicit, default-off **승인 없이 진행** option covering file changes, execution settings and terminal commands. Capture the policy per submitted task, show it even when options are collapsed, and lock it while running.
- Preserve path/secret/read/hash/dirty-file protections, read-only tasks, stop, diffs and file undo. Model replies cannot grant automatic approval. Normal change/command reviews remain the default.
- Record automatic file/command approvals and verify real execution-setting writes and terminal commands without prompts, followed by normal approval on the next request.

## 0.8.1

- Place chat in the Secondary Side Bar by default, with a minimum supported VS Code version of 1.106.
- Make M365 Agent: Open on the Right restore only the agent view and container to their defaults, recovering saved pre-upgrade/custom locations. Honor the user's placement of the Secondary Side Bar itself.
- Verify default placement and recovery from a moved view in actual VS Code.

## 0.8.0

- Improve response typography, heading hierarchy, paragraph spacing, inline emphasis and narrow-sidebar layouts.
- Group consecutive tool/system events into collapsible activity cards; automatically reveal tool failures while retaining separate change and command approvals.
- Preserve the reading position during new events and same-conversation web synchronization. Add a latest-response jump button and preserve expanded activity/code-wrap choices across refreshes.
- Add per-code wrapping, clipboard acknowledgement, whole-response Markdown copying and a reusable read-only editor tab for wider answers.
- Add persisted 12–18px reading size and wrapping preferences. Compact the composer and fold model/context/approval settings while keeping approval mode visible.
- Verify reading controls, activity grouping, synchronization scrolling, dark/light rendering, narrow layouts and the response panel in real VS Code.

## 0.7.0

- Display the actual automation browser in a VS Code editor panel by default, with live frames, mouse/keyboard/IME input, tab selection, navigation and an external-browser fallback. Keep the existing dedicated Edge profile; no iframe, localhost server, cookie extraction or security-header overrides.
- Allow manual login before the queued task starts; lock browser input during automated submission/response collection and model-menu interaction. Reject stale input after page/viewport changes, bound pending frames and pause capture when hidden.
- Follow the latest user's input language for model summaries/answers, giving explicit response-language requests precedence. Preserve original text through review/test shortcuts instead of adding Korean task instructions.
- Include stable task progress in follow-ups, automatically read proposal targets after validation failures, and stop repeated unchanged reads/validation failures after correction attempts instead of consuming all rounds. Keep file/hash/review/command protections.

## 0.6.0

- Merge compatible current-request JSON across separate code blocks and overlapping response containers: per-file proposals, nonconflicting partial edits, distinct tool calls and explanatory completions.
- Keep blocking conflicting same-file content/hashes. Wait for transient streaming conflicts to settle before rejecting; retain local read/hash/unique-anchor/overlap validation.
- Execute tools before premature changes/done in the same response and request fresh proposals from the actual tool results; never replay those premature changes.
- Use consistent SVG header icons with Korean accessible labels. Move synchronization and diagnostics into the More menu.
- Add a conversation-history panel with title search, opening, persistent custom titles and confirmed individual/bulk deletion. Changes affect local VS Code records only; web originals and workspace files remain untouched.

## 0.5.2

- Always review dot-rc JavaScript/TypeScript files, setup hooks and pre-commit configs in addition to the existing execution-config policy.
- Add `/ask` and `/agent` as explicit overrides without a mode picker or forced-edit retries.
- Increase the default round limit from 12 to 20; show the current request and remaining rounds independently of browser status messages. Explicitly configured limits remain respected.
- Remove the redundant session-to-page map and use the browser's single active page directly.
- Add new-chat lifecycle, retry and cancellation coverage alongside the existing stale-sync race tests. Reject cancellation received during web preparation or immediately before agent construction.

## 0.5.1

- Remove word-triggered forced-edit retries. Unknown edit wording retains normal tools; explicit explanation/advice questions and read-only shortcuts cannot apply changes. Report the actual applied-file count separately from model text.
- Expand mandatory review to executable test/tool configs, pytest/tox/nox files, Cargo settings and Gradle/Maven wrappers. Group command-review changes by current versus earlier request without dropping earlier evidence.
- Reuse the current automation tab for history/new-chat navigation, prune closed references and preserve manually written web drafts.
- Invalidate pending history sync on chat selection, new chat, task start and cancellation. Reject stale snapshots even after switching away and back to the same session.
- Extract conversation, model-selection and file-change/command controllers from the extension entry point.
- Keep the 12,000-character default. Bound tool batches to 1–4 calls by input budget (2 at the default), explicitly defer excess calls, and inspect fewer source files initially.
- Pin all direct runtime/development dependencies to the exact lockfile versions.

## 0.5.0

- Keep the first request queued through login/MFA, new authentication tabs and composer hydration. Retry only confirmed pre-submit resets; restore failed tasks without overwriting new drafts.
- Deduplicate semantically identical JSON across response widgets and key order while rejecting genuinely conflicting actions.
- Replace the Ask/Plan/Agent picker with natural-language intent routing. Retain read-only analysis and explicit change/command approvals.
- Read account-visible web model menus, including nested More menus, and apply selections through the web UI.
- Render assistant Markdown headings, lists, tables and code with copy buttons. Disable raw HTML, script links and remote images.
- Map local sessions to web conversation URLs. Poll the current rendered web conversation while idle, merge manual web turns without replaying actions, and reopen linked chats from local history. No full-account archive/deletion synchronization.

## 0.4.0

- Inspect the workspace locally before the first model request: rank project/source files and send bounded real file reads automatically, without requiring attachments or an initial model tool call.
- Add a browser-independent project check that reads source and creates/reads/deletes its own temporary file to verify local write access.
- Raise the default text-file limit from 128KB to 16MB (configurable up to 128MB). Charge edit payload size rather than the complete resulting file against the batch budget.
- Page within long lines using startColumn/nextColumn; support scoped directory listings/search and UTF-16 BOM source files.
- Accept tool arguments in standard nested object/JSON-string wrappers while retaining path/hash protections.
- Do not report requested edits complete when no file changes were applied. Show read counts, the selected project and explicit review-wait status.

## 0.3.1

- Collect rendered JSON from tenant-specific code widgets, highlighted spans, open shadow roots and child frames, beyond pre/code tags.
- Parse balanced JSON objects surrounded by language headings/copy controls. Normalize editor whitespace only outside JSON strings.
- Ignore disabled/unrelated Stop controls and stabilize the parsed JSON rather than changing copy/footer text.
- Reject outgoing prompt echoes, stale IDs and conflicting current-turn responses. Protocol examples now use placeholder IDs.
- Add response-stage diagnostics with candidate counts, ID matches, parsing and generation state; never log captured response bodies.

## 0.3.0

- Add bounded line-range reads and exact partial edits for files up to 128KB. Reject unseen, ambiguous, overlapping or stale edit anchors.
- Always require review for execution configs, dependency manifests, build/CI files and shell scripts, even when normal edit review is disabled.
- Show agent-modified files and native diffs alongside command approval.
- Decode terminal output as streams; support UTF-8 and CP949 with matching Windows code pages.
- Search directly on disk without opening files in the editor. Expand credential/state/config exclusions.
- Extract webview rendering and review policy modules, fix indentation and enforce ESLint checks.
- Run the VS Code extension-host integration test in CI and guard packages/source archives against tracked test profiles.

- Replace the custom `m365-agent` response fence with standard `json`, retaining legacy response parsing.
- Compact requests into one paragraph with JSON-escaped file contents; reduce the default prompt cap from 48,000 to 12,000 characters.
- Verify rich-editor text using DOM text and paragraph structure, preserving code indentation while tolerating editor paragraph gaps and nonbreaking spaces.
- Read native input limits before filling. Rebuild context only after a confirmed pre-submit size rejection; never retry a clicked/unconfirmed Send.
- Distinguish actual truncation from other input changes, expose character counts in diagnostics, and clean only identifiable unsent automation drafts.
- Recover recognizable protocol drafts left by older versions while preserving ordinary user drafts.

## 0.2.0

- Fix requests left in the M365 composer: detect and click Send, wait for enabled state, and confirm submission before waiting for a response. Never blindly retry an unconfirmed submission.
- Chat-first sidebar with Enter / Shift+Enter, Korean IME support, code blocks, file attachments, tool progress and actionable errors.
- Ask and Plan modes enforce read-only tools; Agent mode supports reviewed edits and individually approved shell commands for tests/builds.
- Local conversation history (20 sessions), follow-up context, draft preservation and `/plan`, `/review`, `/test` shortcuts.
- Review changes by default; open native VS Code diffs, apply/reject, and undo the most recent edit batch while protecting subsequent user edits.
- Tests cover non-submitting Enter, disabled/unresponsive Send, read-only modes, command results, webview controls and VS Code integration.

Known limitation: authenticated company-tenant UI integration still requires verification in the user's environment. No inline completions, background agents or full parity with commercial coding agents.

## 0.1.0

- Initial experimental preview for Windows and Microsoft Edge.
- Automatic request and response exchange with an authenticated M365 Copilot web session through Playwright.
- Workspace file listing, reading, literal text search, file creation and file replacement.
- Optional diff review and automatic save after validation.
- File hash conflict checks, dirty-editor protection and workspace path boundaries.
- Local Edge protocol tests and a VS Code extension-host integration test.

Known limitation: authenticated company-tenant UI integration has not yet been verified. M365 page changes may require selector adjustments.
