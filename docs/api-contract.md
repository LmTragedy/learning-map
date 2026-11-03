# Frontend contract

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
