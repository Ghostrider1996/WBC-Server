const { getPool, query } = require("../db/pool");

const MAX_NAME_LENGTH = 40;
const MAX_EVENT_NAME_LENGTH = 80;
const MAX_STREAM_CLIENTS = 1000;
const HEARTBEAT_MS = 25000;

const clients = new Set();
let heartbeat = null;

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// ---------------------------------------------------------------- presenting

function presentEvent(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    totalLocations: row.total_locations,
    startedAt: new Date(row.started_at).getTime(),
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
  };
}

function presentParticipant(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    locationsFound: row.locations_found,
    accumulatedMs: Number(row.accumulated_ms),
    startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
    finalMs: row.final_ms === null ? null : Number(row.final_ms),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
    finishReason: row.finish_reason,
    createdAt: new Date(row.created_at).getTime(),
  };
}

function elapsedMs(row, now) {
  const base = Number(row.accumulated_ms);
  return row.started_at ? base + Math.max(0, now - new Date(row.started_at).getTime()) : base;
}

// ---------------------------------------------------------------- live stream

function writeEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(type, data) {
  const payload = { ...data, serverTime: Date.now() };
  for (const res of clients) {
    try {
      writeEvent(res, type, payload);
    } catch {
      clients.delete(res);
    }
  }
}

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        // A named event (not a comment) so browsers can see it and detect a silent connection.
        writeEvent(res, "ping", { serverTime: Date.now() });
      } catch {
        clients.delete(res);
      }
    }
    if (clients.size === 0) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

async function openStream(req, res) {
  if (clients.size >= MAX_STREAM_CLIENTS) {
    return res.status(503).json({ reason: "The live board is full. Try again shortly." });
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");

  clients.add(res);
  startHeartbeat();
  // Listen on the response: the request's "close" fires once the request is read, not when the client leaves.
  res.on("close", () => clients.delete(res));

  try {
    writeEvent(res, "snapshot", await getSnapshot());
  } catch (error) {
    console.error("Hunt snapshot failed:", error.message);
    writeEvent(res, "error", { reason: "Could not load the hunt board." });
  }
  return undefined;
}

// ---------------------------------------------------------------- reads

async function getLiveEventRow(db = { query }) {
  const existing = await db.query("SELECT * FROM hunt_events WHERE status = 'live' LIMIT 1");
  return existing.rows[0] || null;
}

async function getSnapshot() {
  const event = await getLiveEventRow();
  if (!event) {
    return { serverTime: Date.now(), event: null, participants: [] };
  }

  const participants = await query(
    "SELECT * FROM hunt_participants WHERE event_id = $1 ORDER BY created_at ASC",
    [event.id],
  );

  return {
    serverTime: Date.now(),
    event: presentEvent(event),
    participants: participants.rows.map(presentParticipant),
  };
}

async function listPastEvents() {
  const events = await query(
    "SELECT * FROM hunt_events WHERE status = 'ended' ORDER BY ended_at DESC NULLS LAST, started_at DESC",
  );
  const ids = events.rows.map((row) => row.id);
  const participants = ids.length === 0
    ? { rows: [] }
    : await query(
      "SELECT * FROM hunt_participants WHERE event_id = ANY($1::uuid[]) ORDER BY created_at ASC",
      [ids],
    );

  return {
    serverTime: Date.now(),
    events: events.rows.map((row) => ({
      event: presentEvent(row),
      participants: participants.rows
        .filter((participant) => participant.event_id === row.id)
        .map(presentParticipant),
    })),
  };
}

// ---------------------------------------------------------------- writes

async function withParticipant(participantId, work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT p.*, e.total_locations, e.status AS event_status
         FROM hunt_participants p
         JOIN hunt_events e ON e.id = p.event_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [participantId],
    );
    if (result.rowCount === 0) throw fail("Participant not found.", 404);
    const row = result.rows[0];
    if (row.event_status !== "live") throw fail("This hunt has ended.", 409);

    const updated = await work(client, row, Date.now());
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function saveParticipant(client, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((key, index) => `${key} = $${index + 2}`).join(", ");
  const result = await client.query(
    `UPDATE hunt_participants SET ${sets} WHERE id = $1 RETURNING *`,
    [id, ...keys.map((key) => fields[key])],
  );
  return result.rows[0];
}

function announce(row) {
  const participant = presentParticipant(row);
  broadcast("participant", { participant });
  return participant;
}

function cleanName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw fail("A name is required.", 400);
  if (name.length > MAX_NAME_LENGTH) throw fail(`Names can be up to ${MAX_NAME_LENGTH} characters.`, 400);
  return name;
}

async function addParticipant(rawName) {
  const name = cleanName(rawName);
  const event = await getLiveEventRow();
  if (!event) throw fail("There is no active hunt event. Create one first.", 409);

  const duplicate = await query(
    "SELECT 1 FROM hunt_participants WHERE event_id = $1 AND lower(name) = lower($2) LIMIT 1",
    [event.id, name],
  );
  if (duplicate.rowCount > 0) throw fail("That name is already on the board.", 409);

  const result = await query(
    "INSERT INTO hunt_participants (event_id, name) VALUES ($1, $2) RETURNING *",
    [event.id, name],
  );
  return announce(result.rows[0]);
}

function startParticipant(id) {
  return withParticipant(id, async (client, row, now) => {
    if (row.status === "running") return announce(row);
    if (row.status === "finished") throw fail("This participant has already finished.", 409);

    return announce(await saveParticipant(client, id, {
      status: "running",
      started_at: new Date(now),
    }));
  });
}

function pauseParticipant(id) {
  return withParticipant(id, async (client, row, now) => {
    if (row.status !== "running") return announce(row);

    return announce(await saveParticipant(client, id, {
      status: "paused",
      accumulated_ms: elapsedMs(row, now),
      started_at: null,
    }));
  });
}

function resetParticipant(id) {
  return withParticipant(id, async (client, row) => {
    await client.query(
      "UPDATE hunt_findings SET revoked_at = now() WHERE participant_id = $1 AND revoked_at IS NULL",
      [row.id],
    );

    return announce(await saveParticipant(client, id, {
      status: "ready",
      accumulated_ms: 0,
      started_at: null,
      locations_found: 0,
      final_ms: null,
      finished_at: null,
      finish_reason: null,
    }));
  });
}

function stopParticipant(id) {
  return withParticipant(id, async (client, row, now) => {
    if (row.status === "finished") return announce(row);

    const total = elapsedMs(row, now);
    return announce(await saveParticipant(client, id, {
      status: "finished",
      accumulated_ms: total,
      started_at: null,
      final_ms: total,
      finished_at: new Date(now),
      finish_reason: "stopped",
    }));
  });
}

function changeLocations(id, delta) {
  if (delta !== 1 && delta !== -1) {
    return Promise.reject(fail("delta must be 1 or -1.", 400));
  }

  return withParticipant(id, async (client, row, now) => {
    if (delta === 1) {
      if (row.status === "ready") throw fail("Start the timer before logging a location.", 409);
      if (row.status === "finished") throw fail("This participant has already finished.", 409);
      if (row.locations_found >= row.total_locations) throw fail("All locations are already found.", 409);

      const total = elapsedMs(row, now);
      await client.query(
        "INSERT INTO hunt_findings (participant_id, elapsed_ms) VALUES ($1, $2)",
        [row.id, total],
      );

      const found = row.locations_found + 1;
      if (found >= row.total_locations) {
        return announce(await saveParticipant(client, id, {
          locations_found: found,
          status: "finished",
          accumulated_ms: total,
          started_at: null,
          final_ms: total,
          finished_at: new Date(now),
          finish_reason: "all_found",
        }));
      }

      return announce(await saveParticipant(client, id, { locations_found: found }));
    }

    if (row.locations_found <= 0) throw fail("No locations to remove.", 409);
    if (row.status === "finished" && row.finish_reason !== "all_found") {
      throw fail("A stopped participant cannot be changed. Reset them instead.", 409);
    }

    await client.query(
      `UPDATE hunt_findings SET revoked_at = now()
        WHERE id = (
          SELECT id FROM hunt_findings
           WHERE participant_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 1
        )`,
      [row.id],
    );

    const found = row.locations_found - 1;
    if (row.status === "finished") {
      return announce(await saveParticipant(client, id, {
        locations_found: found,
        status: "paused",
        accumulated_ms: Number(row.final_ms ?? row.accumulated_ms),
        started_at: null,
        final_ms: null,
        finished_at: null,
        finish_reason: null,
      }));
    }

    return announce(await saveParticipant(client, id, { locations_found: found }));
  });
}

async function deleteParticipant(id) {
  const result = await query("DELETE FROM hunt_participants WHERE id = $1 RETURNING id", [id]);
  if (result.rowCount === 0) throw fail("Participant not found.", 404);
  broadcast("participant-removed", { id });
  return { id };
}

async function createEvent(rawName) {
  const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim() : "";
  if (!name) throw fail("An event name is required.", 400);
  if (name.length > MAX_EVENT_NAME_LENGTH) {
    throw fail(`Event names can be up to ${MAX_EVENT_NAME_LENGTH} characters.`, 400);
  }

  try {
    await query("INSERT INTO hunt_events (name) VALUES ($1)", [name]);
  } catch (error) {
    if (error.code === "23505") {
      throw fail("A hunt event is already running. Conclude it before creating a new one.", 409);
    }
    throw error;
  }

  const snapshot = await getSnapshot();
  broadcast("snapshot", snapshot);
  return snapshot;
}

async function concludeEvent() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const live = await client.query("SELECT * FROM hunt_events WHERE status = 'live' FOR UPDATE");
    if (live.rowCount === 0) throw fail("There is no active hunt event to conclude.", 409);

    const event = live.rows[0];
    const now = Date.now();
    const unfinished = await client.query(
      `SELECT * FROM hunt_participants
        WHERE event_id = $1 AND status IN ('running', 'paused')
        FOR UPDATE`,
      [event.id],
    );

    // Anyone still on the clock is stopped where they are, so the results are final.
    for (const row of unfinished.rows) {
      const total = elapsedMs(row, now);
      await client.query(
        `UPDATE hunt_participants
            SET status = 'finished', accumulated_ms = $2, started_at = NULL,
                final_ms = $2, finished_at = $3, finish_reason = 'stopped'
          WHERE id = $1`,
        [row.id, total, new Date(now)],
      );
    }

    await client.query(
      "UPDATE hunt_events SET status = 'ended', ended_at = $2 WHERE id = $1",
      [event.id, new Date(now)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getSnapshot();
  broadcast("snapshot", snapshot);
  return snapshot;
}

module.exports = {
  addParticipant,
  changeLocations,
  concludeEvent,
  createEvent,
  deleteParticipant,
  getSnapshot,
  listPastEvents,
  openStream,
  pauseParticipant,
  resetParticipant,
  startParticipant,
  stopParticipant,
};
