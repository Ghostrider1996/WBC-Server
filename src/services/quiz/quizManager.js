const { QuizGame, QuizGameError, PHASES } = require("./quizGame");
const defaultStore = require("./quizStore");

const FINISHED_KEEP_MS = 30 * 60 * 1000;
const LOBBY_IDLE_MS = 6 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/**
 * Keeps the running games in memory and ties them to the database: a game is
 * created lazily when someone first joins an open session, saves each graded
 * question as it happens, and is dropped a while after it finishes.
 */
class QuizManager {
  constructor({ store = defaultStore, now = Date.now, createGame, logger = console } = {}) {
    this.store = store;
    this.now = now;
    this.logger = logger;
    this.createGame = createGame || ((options) => new QuizGame(options));
    this.games = new Map();
    this.loading = new Map();
    this.sweeper = null;
  }

  startSweeping() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  stopSweeping() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Returns the live game for an open session, or null when it does not exist or is over. */
  async getGame(sessionId) {
    const existing = this.games.get(sessionId);
    if (existing) return existing;

    if (!this.loading.has(sessionId)) {
      this.loading.set(sessionId, this.load(sessionId).finally(() => this.loading.delete(sessionId)));
    }
    return this.loading.get(sessionId);
  }

  async load(sessionId) {
    const session = await this.store.getSession(sessionId);
    if (!session || (session.status !== "lobby" && session.status !== "live")) return null;

    if (session.status === "live") {
      // A running game lives in memory only, so one found "live" without a game was cut off by a restart.
      await this.store.markFinished(sessionId, { cancelled: true }).catch((error) => {
        this.logger.error("Could not close an interrupted quiz:", error.message);
      });
      return null;
    }

    const game = this.createGame({ id: session.id, title: session.title, settings: session.settings });
    game.meta = {
      raidHelperEventId: session.raidHelperEventId,
      allowedDiscordIds: new Set(session.allowedDiscordIds || []),
      hostDiscordId: session.hostDiscordId,
      rounds: session.rounds,
    };

    game.on("locked", (summary) => {
      this.store.saveLockedQuestion(session.id, summary).catch((error) => {
        this.logger.error("Could not save quiz results:", error.message);
      });
    });
    game.on("finished", (summary) => {
      this.store.markFinished(session.id, summary).catch((error) => {
        this.logger.error("Could not close the quiz:", error.message);
      });
    });

    this.games.set(session.id, game);
    return game;
  }

  /** Draws the questions and begins the game. Throws QuizGameError for expected problems. */
  async start(sessionId) {
    const game = await this.getGame(sessionId);
    if (!game) throw new QuizGameError("not_found", "That quiz is not open.");
    if (game.phase !== PHASES.LOBBY) throw new QuizGameError("bad_phase", "The quiz has already started.");
    if (game.players.size === 0) throw new QuizGameError("no_players", "Wait for at least one player to join.");
    if (game.starting) throw new QuizGameError("bad_phase", "The quiz is already starting.");

    game.starting = true;
    try {
      const questions = await this.store.pickQuestions(game.meta.rounds);
      game.start(questions);
      await this.store.markStarted(sessionId, questions).catch((error) => {
        this.logger.error("Could not record the quiz start:", error.message);
      });
    } finally {
      game.starting = false;
    }
    return game;
  }

  /** Cancels a quiz whether or not anyone has joined it yet. */
  async cancel(sessionId) {
    const game = this.games.get(sessionId);
    if (game) {
      game.end({ cancelled: true });
      return;
    }
    await this.store.markFinished(sessionId, { cancelled: true });
  }

  sweep() {
    const current = this.now();
    for (const [id, game] of this.games) {
      const idle = current - game.lastActivityAt;
      if (game.phase === PHASES.FINISHED && idle > FINISHED_KEEP_MS) {
        this.drop(id);
      } else if (game.phase === PHASES.LOBBY && idle > LOBBY_IDLE_MS) {
        game.end({ cancelled: true });
        this.drop(id);
      }
    }
  }

  drop(id) {
    const game = this.games.get(id);
    if (!game) return;
    game.dispose();
    this.games.delete(id);
  }

  shutdown() {
    this.stopSweeping();
    for (const id of [...this.games.keys()]) this.drop(id);
  }
}

let sharedManager = null;

/** The one manager the REST routes and the sockets share, so cancelling really ends a live game. */
function getSharedManager() {
  if (!sharedManager) sharedManager = new QuizManager();
  return sharedManager;
}

module.exports = { QuizManager, getSharedManager };
