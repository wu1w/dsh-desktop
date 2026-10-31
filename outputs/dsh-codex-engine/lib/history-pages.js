import { EngineError } from "./errors.js";

const PREFIX = "dsh-turn-items-v1:";
const DIRECTIONS = new Set(["asc", "desc"]);
const MAX_TURNS_PER_PAGE = 100;
const opposite = direction => direction === "desc" ? "asc" : "desc";

export function isTurnItemsCursor(cursor) {
  return typeof cursor === "string" && cursor.startsWith(PREFIX);
}

function encode(threadId, sortDirection, position) {
  return PREFIX + Buffer.from(JSON.stringify({ version: 1, threadId, sortDirection, ...position })).toString("base64url");
}

function invalid(t, stale = false) {
  throw new EngineError(stale ? "HISTORY_CURSOR_STALE" : "INVALID_HISTORY_PAGE", stale ? "error.history_cursor_stale" : "error.invalid_history_page", {}, t);
}

function decode(cursor, threadId, sortDirection, t) {
  if (!isTurnItemsCursor(cursor)) invalid(t);
  let value;
  try { value = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8")); }
  catch { invalid(t); }
  if (!value || value.version !== 1 || value.threadId !== threadId || value.sortDirection !== sortDirection) invalid(t);
  if (value.position === "turn") {
    if (typeof value.turnCursor !== "string" || !value.turnCursor) invalid(t);
  } else if (value.position === "item") {
    if (typeof value.anchorCursor !== "string" || !value.anchorCursor || !DIRECTIONS.has(value.anchorDirection)
      || typeof value.turnId !== "string" || !value.turnId || typeof value.itemId !== "string" || !value.itemId
      || typeof value.inclusive !== "boolean") invalid(t);
  } else invalid(t);
  return value;
}

async function turnPage(client, threadId, cursor, direction, itemsView, t) {
  const result = await client.request("thread/turns/list", {
    threadId, ...(cursor == null ? {} : { cursor }), limit: 1, sortDirection: direction, itemsView,
  });
  if (!Array.isArray(result?.data) || result.data.length > 1
    || (result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor))
    || (result.backwardsCursor != null && (typeof result.backwardsCursor !== "string" || !result.backwardsCursor))) {
    throw new EngineError("PROTOCOL", "error.protocol", {}, t);
  }
  return { ...result, requestCursor: cursor ?? null, direction };
}

function itemCursor(threadId, direction, page, turn, item, inclusive, t) {
  if (!page.backwardsCursor) throw new EngineError("PROTOCOL", "error.protocol", {}, t);
  return encode(threadId, direction, {
    position: "item", anchorCursor: page.backwardsCursor,
    anchorDirection: opposite(page.direction), turnId: turn.id, itemId: item.id, inclusive,
  });
}

/** Adapt legacy threads using bounded native full-turn pages, without loading the complete thread. */
export async function legacyItemsPage(client, threadId, options, t) {
  const { sortDirection, limit } = options;
  const cursor = options.cursor == null ? null : decode(options.cursor, threadId, sortDirection, t);
  let current, startItemId = null, inclusive = false;
  if (cursor?.position === "item") {
    // A native backwards cursor includes its anchor turn in the opposite
    // direction. Reverse it again when needed to position the full turn page
    // in the caller's direction without relying on cursor internals.
    const anchor = await turnPage(client, threadId, cursor.anchorCursor, cursor.anchorDirection,
      cursor.anchorDirection === sortDirection ? "full" : "notLoaded", t);
    if (anchor.data[0]?.id !== cursor.turnId) invalid(t, true);
    current = cursor.anchorDirection === sortDirection ? anchor
      : await turnPage(client, threadId, anchor.backwardsCursor, sortDirection, "full", t);
    if (current.data[0]?.id !== cursor.turnId) invalid(t, true);
    startItemId = cursor.itemId;
    inclusive = cursor.inclusive;
  } else {
    current = await turnPage(client, threadId, cursor?.turnCursor, sortDirection, "full", t);
  }
  const data = [], seen = new Set(), seenCursors = new Set();
  let backwardsCursor = null;
  for (let scanned = 0; scanned < MAX_TURNS_PER_PAGE; scanned++) {
    seenCursors.add(current.requestCursor);
    if (current.nextCursor != null && seenCursors.has(current.nextCursor)) {
      throw new EngineError("PROTOCOL", "error.protocol", {}, t);
    }
    const turn = current.data[0];
    // Empty native pages can still have a valid continuation (for example,
    // when a legacy turn was filtered). They consume the same bounded scan
    // budget as empty turns rather than ending the entire history window.
    if (turn && (!turn.id || !Array.isArray(turn.items) || turn.itemsView !== "full" || seen.has(turn.id))) {
      throw new EngineError("PROTOCOL", "error.protocol", {}, t);
    }
    if (turn) seen.add(turn.id);
    const items = turn ? sortDirection === "desc" ? [...turn.items].reverse() : turn.items : [];
    let offset = 0;
    if (startItemId != null) {
      const index = items.findIndex(item => item.id === startItemId);
      if (index < 0) invalid(t, true);
      offset = index + (inclusive ? 0 : 1);
      startItemId = null;
    }
    for (let index = offset; index < items.length; index++) {
      const item = items[index];
      if (typeof item?.id !== "string" || !item.id) throw new EngineError("PROTOCOL", "error.protocol", {}, t);
      if (!backwardsCursor) backwardsCursor = itemCursor(threadId, opposite(sortDirection), current, turn, item, true, t);
      // Legacy full-turn history has no per-item timestamps. Do not substitute
      // the turn's seconds-based timestamps for native item millisecond times.
      data.push({ turnId: turn.id, item, startedAtMs: null, completedAtMs: null });
      if (data.length === limit) {
        const nextCursor = index + 1 < items.length
          ? itemCursor(threadId, sortDirection, current, turn, item, false, t)
          : current.nextCursor ? encode(threadId, sortDirection, { position: "turn", turnCursor: current.nextCursor }) : null;
        return { data, nextCursor, backwardsCursor };
      }
    }
    if (!current.nextCursor) return { data, nextCursor: null, backwardsCursor };
    if (scanned + 1 === MAX_TURNS_PER_PAGE) {
      return { data, nextCursor: encode(threadId, sortDirection, { position: "turn", turnCursor: current.nextCursor }), backwardsCursor };
    }
    current = await turnPage(client, threadId, current.nextCursor, sortDirection, "full", t);
  }
}
