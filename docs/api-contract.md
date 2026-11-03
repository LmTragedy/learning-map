# Frontend contract

## Personal notes

PUT `/api/courses/{cid}/nodes/{nid}/personal-note` accepts `{content:string,expected:string}` and returns the projected course. Both strings are limited to 100,000 characters; empty content explicitly clears a note. `expected` is the original saved text, not a newly fetched baseline substituted during draft recovery. Legacy nodes without `personal_note` behave as empty notes. A missing course/node returns 404. A stale original text returns 409 without changing the course revision or creating a snapshot. Successful saves update `personal_note` and, when due, create a pre-change course snapshot in the same SQLite transaction (consecutive note-save backups coalesce within ten minutes); other node state is preserved. Existing snapshot/restore/trash mechanisms include these fields.

Browser drafts are separate from this API and retain their original baseline. Reading the latest course does not confirm a merge. Conflict resolution shows the saved text, requires explicit user review, and still uses this endpoint's comparison on the subsequent save. There is no AI write endpoint for personal notes and no automatic Obsidian write.

`personal_note` is the Markdown source for the entire knowledge node, shared across learning tabs and PDF review scopes. The independent node document's live/source/reading modes do not change the API or create separate conversation notes. Presentation never rewrites existing content; saves use the exact current Markdown. Current editing autosaves after 1.5 seconds or explicitly via Ctrl+S; conflicts pause autosave. No migration of existing text notes is required.

### Read-only AI note review

POST `/api/courses/{cid}/nodes/{nid}/personal-note/review` accepts `{content,revision,request_id,note_id?}`. `content` is the complete current draft (1–100,000 characters), `revision` is the displayed course revision, and `request_id` is a 1–80 character client correlation ID. Omit `note_id` for the node's main note; named notes must exist and be bound to this node. This endpoint does not save notes or change any course state. It requires enabled AI and uses the separate settings field `note_review_model` (default `gpt-6-luna`, medium reasoning). Partial settings updates preserve unrelated preferences.

Response: `{request_id,note_id,revision,scope_key,model,content_hash,suggestions,warnings}`. Each of at most three suggestions includes `{id,category,original,replacement,reason,from,to,line,sources}`. `category` is `knowledge_logic`, `english` or `uncertain`; `from`/`to` are UTF-16 offsets into the submitted snapshot, and `line` is one-based. Verified sources contain `{material_id,page,quote,name,uncertain}` and must match allowed extracted page text. Unsupported or OCR-uncertain knowledge claims become `uncertain`; quotation matching does not establish semantic correctness. Missing, duplicate or overlapping anchors are omitted with a warning.

Stale revisions or overlapping provider work return 409, disabled AI returns 400, and unavailable Codex returns 503. Editing and ordinary saving remain independent. The client waits 1.8 seconds after changes, discards responses for old text/note/context, and validates the entire snapshot and exact excerpt again before one user-confirmed editor transaction. Failure or a 60-second client timeout pauses checking until manual retry. Closing an editor stops client waiting; it may not terminate an already-running provider request. Existing server provider timeouts and concurrency bounds still apply.

## Shared contract

Same-origin JSON API `/api`. All mutation requests include header `X-Learning-Map: 1`; server checks Origin/Host. Errors `{detail:string}`. All course mutations return full course object unless stated. Fetch course after import/generate or actions. No placeholder data. Empty state offers create course and optional explicitly labelled sample course.

Course: `{id,title,revision,created_at,materials:Material[],nodes:Node[],edges:Edge[],ratings:Rating[],suggestions:Suggestion[],preferences:{pace:string}}`.
Material: `{id,name,week,kind,sha256,pages:[{number,text,method,uncertain,warnings:string[]}],warnings:string[]}`. Original `/api/courses/{cid}/materials/{mid}/file`; page image `/api/courses/{cid}/materials/{mid}/pages/{page}`.
Node: `{id,title,summary,week,sources:[{material_id,page,quote}],prerequisites:string[],status:'new'|'studied'|'mastered'|'passed',verification:'none'|'ai_passed'|'user_passed'|'review',uncertain:boolean,difficulty:string,chats:[{id,role,content,created_at}],attempts:Attempt[],question?:{prompt,kind,rubric},thread_id?:string,unlocked:boolean}`. `unlocked` is server-derived; direct entry is UI-only and never changes it. Edge `{id,source,target,relation,uncertain}`.
Attempt: `{id,question,answer,reference,attachments:Material[],judgment:{outcome:'passed'|'failed'|'uncertain',reasoning,blockers:string[],next_step},resolution?:string,rating_state:'pending'|'submitted'|'skipped',created_at}`.

Course responses additionally include derived `route:{stages:[{id,title,node_ids:string[]}],next_node_id:string|null,completed_count,total,warning}`. Stages group two prerequisite depths without changing graph dependencies or unlock rules. Broken dependencies remain visible with a warning. Node `lessons` is optional for legacy courses; saved lesson metadata includes `{id,title,goal,kind,focus,created_at,read_at,check_question,check_answer,recap,request_id,sources,teach_sha256}`. HTML is omitted from course JSON and retrieved separately.

- GET `/health` → `{ai:{available:boolean,...},parser:{...},data_dir}`.
- GET `/courses` → course summaries array `{id,title,node_count,passed_count,material_count,revision}`.
- POST `/courses` `{title}` → course.
- POST `/sample` → sample course, clearly labelled and zero initial progress; local fixture material, no fake model results.
- GET `/courses/{cid}` → course.
- POST `/courses/{cid}/materials` multipart `files` (multiple), `week`, `parser` (`basic` or `docling`); returns course. Basic text extraction/OCR may mark uncertainty.
- POST `/courses/{cid}/generate` `{}` → course; actual AI required. Existing nodes/state retained, version saved.
- POST `/courses/{cid}/nodes/{nid}/mark` `{status:'new'|'studied'|'mastered'}` → course.
- POST `/courses/{cid}/nodes/{nid}/chat` `{message}` → course; persisted independent conversation, real AI.
- POST `/courses/{cid}/nodes/{nid}/lessons` `{kind:'initial'|'supplement',focus:string,request_id:string}` → course. Request ID: 16–80 letters, digits or hyphens. Initial creation reuses existing lessons; duplicate request IDs reuse the saved result. Supplement requires a saved lesson and a nonblank focus of at most 2,000 characters. At most 20 lessons per node. New generation requires enabled AI, snapshots before save, and rejects concurrent course edits with 409. Model/schema/render failures do not save a lesson. On 409, refresh before retrying.
- GET `/courses/{cid}/nodes/{nid}/lessons/{lid}/html?download=false` → sanitized standalone HTML, restrictive CSP. `download=true` supplies an attachment filename. Saved HTML is available with AI disabled.
- POST `/courses/{cid}/nodes/{nid}/lessons/{lid}/read` `{}` → course. Records first read time only; does not change mastery, assessments or prerequisite unlocks.
- GET `/courses/{cid}/nodes/{nid}/recall?q=...` → `{messages:Chat[],note:string}` exact actual messages, including empty history.
- POST `/courses/{cid}/nodes/{nid}/recall-summary` `{}` → `{title,items:[{category,content,evidence_ids}],uncertainties,messages,created_at,history_revision}`. Categories are 学习起点/用户想法/知识连接/当前进展/待继续/AI推测. Actual AI required; each item must cite actual current-node message IDs without duplicates within that item, and 用户想法 may reference user messages only. Reject stale history. Summaries are temporary UI output; original chats, attempts, ratings and mastery remain unchanged. The course retains only the Codex conversation index for this request. Citation validity does not mechanically prove the semantic truth of AI synthesis.
- POST `/courses/{cid}/nodes/{nid}/question` `{}` → course with real generated question.
- POST `/courses/{cid}/nodes/{nid}/attempts` multipart `answer`, `reference`, optional `files`; actual model grade or honest uncertain fallback if not configured/recognition unclear. Preserves submitted evidence; opens feedback prompt.
- POST `/courses/{cid}/nodes/{nid}/attempts/{aid}/resolve` `{decision:'pass'|'supplement'|'review'}` → course; uncertain only.
- POST `/courses/{cid}/nodes/{nid}/attempts/{aid}/rating` `{problem:0..4|null,mastery:0..4|null,comment:string,skip:boolean}` → course. At least one filled or skip; once only.
- GET `/profile` → `{courses,ratings_count,stages:[{id,count,problem_average,mastery_average,advice,accepted}],suggestions:[...]}` global ten actual rating batches, separate denominators. POST `/profile/stages/{sid}/accept` `{}` → profile; only applies disclosed teaching preference `pace`.
- POST `/courses/{cid}/suggestions/{sid}/accept` `{}` → course; streak difficulty suggestion consent.
- GET `/courses/{cid}/versions` → `[{id,created_at,reason,node_count,revision}]`.
- POST `/courses/{cid}/snapshot` `{}` → course; save current version.
- POST `/courses/{cid}/restore-preview` `{version_id}` → `{token,target,contents:string[],warning}`.
- POST `/courses/{cid}/restore` `{token}` → course; backs up current, clears hidden AI sessions.
- POST `/courses/{cid}/delete-preview` `{}` → `{token,target,contents:string[],warning}`.
- POST `/courses/{cid}/delete` `{token}` → `{deleted:true}` (soft delete; full state and copied files retained locally; no in-app trash restoration endpoint in this version).
- GET `/settings` → `{ai_enabled,model,reasoning_effort,obsidian_vault,parser,...}` no secrets. `reasoning_effort` is `low`, `medium` (default), or `high`. POST `/settings` with same user-editable fields → settings. AI enable text must explain selected source/history/answers leave device to Codex provider. Default false.
- GET `/obsidian/notes?q=...` → `[{path,content}]` bounded search configured vault.
- POST `/obsidian/preview` `{path,content}` → `{token,target,content,warning}`.
- POST `/obsidian/write` `{token}` → `{path}`; never overwrite.

Source original text must be labelled extracted / uncertain and never advertised verbatim guaranteed. Full original opens page using `#page=N`. AI chat Markdown is not rendered as raw HTML. Teach markup passes a semantic tag allowlist with all model attributes removed; scripts, external resources, forms and embedded documents are excluded. The application wraps it in shared HTML/CSS and displays it in an empty-sandbox iframe.

## Course goals

- POST `/courses/{cid}/goals` accepts `title`, optional `description`, `kind` (`course`/`personal`), `status` (`todo`/`doing`/`done`), `node_ids` and `subtasks:[{id,title,done}]`; returns the projected course. New subtask IDs may be omitted.
- PUT `/courses/{cid}/goals/{gid}` accepts the same full editable fields plus required `revision`. Missing optional fields use their defaults. A stale revision returns 409; preserve edits, refresh and reopen the editor. The goal's original material sources and creation metadata remain intact. Saves snapshot the prior course.
- POST `/courses/{cid}/goal-candidates` analyzes all course materials with the configured AI and returns `{token,revision,goals:[{title,description,node_ids,subtasks:string[],sources}]}`. It does not add goals or change progress. Source quotes must match extracted page text; this does not establish semantic correctness.
- POST `/courses/{cid}/goals/accept` accepts `{token,indices:int[]}`. Selection must be nonempty, unique and within the preview. The server validates token ownership, revision and 15-minute expiry, snapshots and appends only the selected candidates with initial `todo` state and unchecked subtasks. The token is consumed once on success; failures roll back.

Goals expose derived `progress:{linked,studied,mastered,verified,review,subtasks_done,subtasks_total}`. `linked` counts currently available referenced nodes; `verified` counts whole-course `ai_passed`/`user_passed`, excluding `review` and scope-only results. No projection changes goal state. Legacy goals may omit description, kind, subtasks and sources. Goal data follows the existing course version, restore and soft-delete lifecycle.

## Relationship extension

Edges additionally expose `explanation`, `when_to_use`, `basis`, `evidence_kind` (`material_quote`, `material_inference`, `ai_inference`), `sources`, `confirmed`, `forward_difficulty`, `reverse_difficulty`, `presentation` (`simple`, `synthesis`), optional `synthesis_node_id` and derived `controls_unlock`. Legacy edges receive read-time defaults without rewriting storage. User confirmation is separate from source uncertainty. Difficulty strings are unvalidated estimates in both directions. Editing the relation type never rewrites node prerequisites.

Synthesis nodes are ordinary nodes with `kind:'synthesis'`, `related_node_ids` and `relation_id`; they use the existing lesson and assessment endpoints. Their graph connections reference `origin_relation_id` and resolve edits to the canonical relationship. Switching back to simple presentation retains synthesis history. Same-title material differences are retained in optional node `material_variants:[{summary,sources,uncertain}]` rather than replacing the original summary.

- POST `/courses/{cid}/relations/{rid}/presentation` `{presentation,revision}` → course; creates or reuses a synthesis node when requested.
- POST `/courses/{cid}/relations/{rid}/confirm` `{revision}` → course; records explicit user review, without clearing source uncertainty.
- POST `/courses/{cid}/relations/{rid}` `{revision,relation,explanation,when_to_use,basis,forward_difficulty,reverse_difficulty}` → course; edits the explanation and estimates, resets confirmation and preserves node progress. Relation values are 前置知识 / 帮助理解 / 工具关系 / 相似或对比 / 归纳关系.

Each operation saves a complete pre-change version inside the same transaction. Stale revisions return 409; refresh before retrying. Missing relations return 404. Strict PDF review excludes an entire relationship if any related node or cited material is outside the selection, and excludes full-course AI inferences; it does not strip only the source links while retaining the explanation. Generated relationships remain unconfirmed even if their quoted text is found on a real page.
