# Validation — 2026-11-03

This is a development build, not a completed evaluation of learning effectiveness.

## Executed

- Python: 42 tests passed. Real temporary SQLite/files are used for persistence, snapshot restore/rollback, copied-source hash checks, stale confirmation rejection, self-mark/evidence distinction, uncertainty decisions, skipped/partial rating and ten-rating batches, cross-course atomic preference changes (including a real SQLite failure trigger), Obsidian exact write/no-overwrite/path protection and foreign-origin rejection.
- Documents: digital PDF with a formula/table, a raster scan PDF and a **printed simulation** of a paper answer photograph. Local cached Tesseract.js really executed on scan and photo. All automatic recognition stays uncertain, with original-page rendering. Docling result validation is tested against boundary payloads; Docling itself is not installed or run.
- AI protocol: real new thread, resumed thread, remembered synthetic phrase, schema-constrained JSON, and schema-constrained question. Protocol failure/tool rejection tests use a fake external process and do not prove model behavior.
- Real AI course: copied synthetic database PDF → 14 source-linked nodes → independent node conversation → content-dependent question → a genuinely failed unrelated answer with specific blockers → corrected answer passed with `ai_passed` → dependent gates recomputed → optional score/skip → exact Recall and new application instance preserved records → resumed original node thread. A printed water-cycle answer photo was actually submitted to the multimodal grader for the database question and correctly identified as unrelated. This does not measure a real learner or handwriting quality.
- A first real question request hit its 180-second timeout while inheriting the CLI reasoning default; after explicitly setting medium effort, the complete rerun and follow-up succeeded. A timeout is an explicit error/uncertain judgment, not a passing result.
- Frontend: TypeScript typecheck, ESLint and Vite production build passed. Frontend and OCR dependency audits reported zero known vulnerabilities at check time; this is not a security guarantee.
- Browser: desktop 1440×1000 and phone 390×844 checked without horizontal overflow. Clicked self-mark, verified fog/explicit direct entry, restored a whole-course version with confirmation, opened original-page image and extracted text, reloaded course state, and checked mobile settings/navigation. No automated browser test suite was added.

Real AI result details and screenshots are in Git-excluded `test-results/live-flow/results.json`, `test-results/desktop.jpg` and `test-results/mobile-settings.jpg`. Ordinary UI testing leaves only a clearly labelled zero-progress sample course in default data; real model integration uses a separate `test-results/live-flow/data` database. No private course files were sent to a model.

## Review order

Architecture choice preceded implementation. Final source was reviewed using code-review-expert → refactor-advisor → clean-code-guard, with test-guard and docs-guard for their respective files. Fixed cumulative OCR time limits, page provenance alignment, model changes on thread resume, transactional stage acceptance, empty source excerpts and mobile navigation. No outstanding P0/P1 findings from the final review. The main React application still has a large collection of dialogs; splitting them is a maintainability follow-up.

## Remaining limits

No real handwriting/complex mathematics accuracy study, no private full-course corpus acceptance, no Docling/MinerU/DeepTutor/LightRAG runtime integration, no clean-machine or non-Windows install test. Difficulty is an adjustable initial estimate; phase advice is an explicit rule suggestion rather than AI-discovered patterns. Node merge/split editing, automatic active-study timing, calibrated directed difficulty weights, speech, multi-device sync, backup import/export and in-app trash restoration are unfinished. Course deletion retains local data and does not remove Codex's own session records.

The test runner currently emits one Starlette/httpx deprecation warning; tests pass. The app-server has no complete tool-disable allowlist; read-only/untrusted policy plus approval/tool rejection is used, and Windows descendant processes retaining pipe handles remain an unproven cleanup edge case.

## Conversation naming and Recall follow-up

The final working-tree suite passed 72 tests. Targeted new coverage includes native thread naming/section RPCs, reuse and pagination of groups, recording course/node names, Recall valid citations, cross-node references, duplicate citations within one item, assistant-as-user attribution, disabled/no-history cases and stale history rejection. The frontend typecheck and build passed; lint had no errors and one fast-refresh warning in the concurrently changed `CourseMap.tsx` module.

Real Terra/high checks verified naming, a metadata-only rename/move, and Recall synthesis from three short synthetic messages. Browser verification clicked “开始整理”, expanded the cited original words and followed the link back to the stored message. Original messages and progress were unchanged. Screenshot: `test-results/recall-summary-live/recall-summary.jpg`. Test conversations were moved to the separate “学习软件 · 验证记录” sidebar group.

Two existing `comp4418｜知识地图生成` conversations were renamed and placed into “学习 · comp4418” through the desktop tools. Native `thread/name/set` is reflected by the desktop. Native section IDs differ from desktop preference section IDs; native regrouping of both an existing thread and a newly created test thread did **not** update desktop section membership. Future automatic desktop sidebar grouping remains incomplete; only automatic naming and native section metadata are implemented.

Review order was repeated for the affected modules; no outstanding P0/P1 code findings. A stale-map-snapshot window was corrected by reading/checking the latest course under the snapshot transaction. Recall citations are source pointers, not a proof that the AI interpretation is correct. The implementation does not claim two-way synchronization of messages written directly in Codex.
