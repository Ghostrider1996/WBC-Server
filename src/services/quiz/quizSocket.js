const { Server } = require("socket.io");
const { createOriginChecker } = require("../../middleware/cors");
const { verifySessionToken } = require("../sessionToken");
const triviaService = require("../triviaService");
const quizStore = require("./quizStore");
const { createSignupChecker } = require("./quizAccess");
const { QuizGameError } = require("./quizGame");
const { getSharedManager } = require("./quizManager");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_ACTIONS = new Set(["start", "next", "pause", "resume", "extend", "kick", "end", "cancel"]);

function roomName(sessionId) {
  return `quiz:${sessionId}`;
}

function hostRoomName(sessionId) {
  return `quiz:${sessionId}:host`;
}

function avatarUrl(discordId, avatar) {
  return avatar ? `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128` : null;
}

async function defaultLoadProfile(discordId) {
  const profile = await quizStore.getPlayerProfile(discordId);
  return { name: profile.name, avatar: avatarUrl(discordId, profile.avatar) };
}

function failure(error) {
  if (error instanceof QuizGameError) return { ok: false, code: error.code, reason: error.message };
  console.error("Quiz socket error:", error?.message);
  return { ok: false, code: "error", reason: "Something went wrong. Try again." };
}

/**
 * Attaches the quiz transport to an HTTP server.
 *
 * Rooms: `quiz:<id>` for everyone, `quiz:<id>:host` for hosts and the big screen.
 * Clients send `quiz:join`, `quiz:answer`, `quiz:host`, `quiz:ping` (all with acks)
 * and receive `quiz:state`, `quiz:progress`, `quiz:waiting`, `quiz:replaced`.
 */
function attachQuizSockets(httpServer, deps = {}) {
  const manager = deps.manager || getSharedManager();
  const signups = deps.signups || createSignupChecker();
  const isHostAllowed = deps.isTriviaAdmin || triviaService.isTriviaAdmin;
  const loadProfile = deps.loadProfile || defaultLoadProfile;
  const readToken = deps.verifySessionToken || verifySessionToken;
  const isAllowedOrigin = deps.isAllowedOrigin || createOriginChecker();

  const io = new Server(httpServer, {
    maxHttpBufferSize: 16 * 1024,
    cors: {
      origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
      credentials: true,
    },
  });

  const attached = new WeakSet();

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const session = typeof token === "string" ? readToken(token) : null;
      if (!session) return next(new Error("Sign in with Discord to join the quiz."));

      const profile = await loadProfile(session.discordId);
      socket.data.discordId = session.discordId;
      socket.data.name = profile.name;
      socket.data.avatar = profile.avatar;
      return next();
    } catch (error) {
      console.error("Quiz socket sign-in failed:", error?.message);
      return next(new Error("Could not sign you in to the quiz."));
    }
  });

  function wire(game) {
    if (attached.has(game)) return;
    attached.add(game);

    const room = roomName(game.id);

    game.on("change", async () => {
      try {
        const state = game.publicState();
        const host = game.hostState();
        const sockets = await io.in(room).fetchSockets();
        for (const socket of sockets) {
          const isHost = socket.data.role === "host";
          socket.emit("quiz:state", {
            state,
            you: game.playerState(socket.data.discordId),
            ...(isHost ? { host } : {}),
            role: socket.data.role,
          });
        }
      } catch (error) {
        console.error("Quiz broadcast failed:", error?.message);
      }
    });

    game.on("progress", (progress) => {
      io.in(room).emit("quiz:progress", progress);
      io.in(hostRoomName(game.id)).emit("quiz:waiting", game.hostState());
    });
  }

  function connectedCount(sessionId, discordId, exceptSocketId) {
    const room = io.sockets.adapter.rooms.get(roomName(sessionId));
    if (!room) return 0;
    let count = 0;
    for (const id of room) {
      const peer = io.sockets.sockets.get(id);
      if (id !== exceptSocketId && peer?.data.discordId === discordId && peer.data.playing) count += 1;
    }
    return count;
  }

  io.on("connection", (socket) => {
    const leave = () => {
      const { sessionId, role, discordId } = socket.data;
      if (!sessionId) return;
      socket.data.sessionId = null;
      socket.leave(roomName(sessionId));
      socket.leave(hostRoomName(sessionId));
      const wasPlaying = socket.data.playing;
      socket.data.playing = false;
      if (wasPlaying && connectedCount(sessionId, discordId, socket.id) === 0) {
        manager.games.get(sessionId)?.setConnected(discordId, false);
      }
    };

    socket.on("quiz:ping", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : typeof payload === "function" ? payload : null;
      if (reply) reply({ serverNow: Date.now() });
    });

    socket.on("quiz:join", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
        if (!UUID_PATTERN.test(sessionId)) return reply({ ok: false, code: "not_found", reason: "That quiz was not found." });

        const game = await manager.getGame(sessionId);
        if (!game) return reply({ ok: false, code: "not_found", reason: "That quiz is not open." });

        const { discordId } = socket.data;
        const canHost = game.meta.hostDiscordId === discordId || await isHostAllowed(discordId);
        const asScreen = payload?.mode === "screen";
        const asPlayer = payload?.mode === "player";
        const asHost = canHost && !asPlayer;

        const eventId = String(game.meta.raidHelperEventId || "").trim();
        if (!canHost && eventId) {
          let signedUp;
          try {
            signedUp = await signups.isSignedUp(eventId, discordId);
          } catch (error) {
            console.error("Quiz sign-up check failed:", error?.message);
            return reply({ ok: false, code: "check_failed", reason: "Could not check your event sign-up right now. Try again in a moment." });
          }
          if (!signedUp) {
            return reply({ ok: false, code: "not_signed_up", reason: "Sign up for this event on the Raids page to join the quiz." });
          }
        }
        if (!canHost && !eventId && !game.meta.allowedDiscordIds?.has(String(discordId))) {
          return reply({
            ok: false,
            code: "not_invited",
            reason: "Only the Discord accounts listed by the host can join this quiz.",
          });
        }

        if (asScreen && !canHost) {
          return reply({ ok: false, code: "forbidden", reason: "Only hosts can open the big screen." });
        }

        leave();
        wire(game);

        const play = !asScreen;
        if (play) {
          game.addPlayer({ discordId, name: socket.data.name, avatar: socket.data.avatar });

          if (!asHost) {
            const room = io.sockets.adapter.rooms.get(roomName(sessionId));
            for (const id of room || []) {
              const peer = io.sockets.sockets.get(id);
              if (peer && peer.id !== socket.id && peer.data.role === "player" && peer.data.discordId === discordId) {
                peer.emit("quiz:replaced");
                peer.data.sessionId = null;
                peer.data.playing = false;
                peer.leave(roomName(sessionId));
              }
            }
          }
        }

        socket.data.role = asHost ? "host" : "player";
        socket.data.playing = play;
        socket.data.sessionId = sessionId;
        await socket.join(asHost ? [roomName(sessionId), hostRoomName(sessionId)] : roomName(sessionId));
        if (play) game.setConnected(discordId, true);

        return reply({
          ok: true,
          role: socket.data.role,
          serverNow: Date.now(),
          state: game.publicState(),
          you: game.playerState(discordId),
          ...(asHost ? { host: game.hostState() } : {}),
        });
      } catch (error) {
        return reply(failure(error));
      }
    });

    socket.on("quiz:answer", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const { sessionId, role, discordId } = socket.data;
        const game = sessionId ? manager.games.get(sessionId) : null;
        if (!game || !socket.data.playing) throw new QuizGameError("not_playing", "Join the quiz first.");
        game.submitAnswer(discordId, payload?.response);
        return reply({ ok: true, you: game.playerState(discordId) });
      } catch (error) {
        return reply(failure(error));
      }
    });

    socket.on("quiz:host", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const { sessionId, role } = socket.data;
        const game = sessionId ? manager.games.get(sessionId) : null;
        if (!game || role !== "host") throw new QuizGameError("forbidden", "Only hosts can do that.");

        const action = payload?.action;
        if (!HOST_ACTIONS.has(action)) throw new QuizGameError("invalid", "Unknown action.");

        if (action === "start") await manager.start(sessionId);
        else if (action === "next") game.next();
        else if (action === "pause") game.pause();
        else if (action === "resume") game.resume();
        else if (action === "extend") game.extend(payload.seconds);
        else if (action === "kick") {
          if (payload.discordId === socket.data.discordId) {
            throw new QuizGameError("invalid", "You cannot remove yourself.");
          }
          if (typeof payload.discordId !== "string" || !game.kick(payload.discordId)) {
            throw new QuizGameError("invalid", "That player is not in the quiz.");
          }
          for (const peer of await io.in(roomName(sessionId)).fetchSockets()) {
            if (peer.data.discordId === payload.discordId && peer.data.role === "player") {
              peer.emit("quiz:removed");
              peer.leave(roomName(sessionId));
            }
          }
        } else if (action === "end") game.end();
        else if (action === "cancel") await manager.cancel(sessionId);

        return reply({ ok: true });
      } catch (error) {
        return reply(failure(error));
      }
    });

    socket.on("disconnect", leave);
  });

  manager.startSweeping();

  return {
    io,
    manager,
    close: async () => {
      manager.shutdown();
      await io.close();
    },
  };
}

module.exports = { attachQuizSockets, hostRoomName, roomName };
