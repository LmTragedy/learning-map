import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { NoteReviewController } from "./noteReview";
import type { ReviewContext } from "./noteReview";

export function useNoteReview(context: ReviewContext) {
  const [controller] = useState(() => new NoteReviewController((snapshot, requestId, signal) =>
    api.reviewPersonalNote(snapshot.courseId, snapshot.nodeId, {
      content: snapshot.content, revision: snapshot.revision, request_id: requestId, note_id: snapshot.noteId || "",
      scope_key: snapshot.scopeKey, model: snapshot.model,
    }, signal)));
  const { courseId, nodeId, noteId, revision, scopeKey, model, content, enabled, available } = context;
  useLayoutEffect(() => {
    controller.update({ courseId, nodeId, noteId, revision, scopeKey, model, content, enabled, available });
  }, [controller, courseId, nodeId, noteId, revision, scopeKey, model, content, enabled, available]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { controller, state: useSyncExternalStore(controller.subscribe, controller.snapshot) };
}
