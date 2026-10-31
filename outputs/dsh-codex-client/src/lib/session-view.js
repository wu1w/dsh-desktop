// A selection can render before passive effects clear the previous session.
// Never attach that previous session's content or actions to the new project.
export function historyForSelection(snapshot, sessionId, running = false) {
  if (snapshot?.sessionId === sessionId) return snapshot;
  return { sessionId, epoch: null, items: [], history: { nextCursor: null, hasMore: false, error: null, errorCode: null }, loadingInitial: Boolean(sessionId), loadingEarlier: false, errorSource: null, running: Boolean(running), reloadRequired: false };
}
export function queueForSelection(snapshot, sessionId) {
  return snapshot?.sessionId === sessionId && Array.isArray(snapshot.items) ? snapshot.items : [];
}
