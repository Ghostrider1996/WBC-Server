const { EventEmitter } = require("events");
const {
  gradeResponse,
  normalizeResponse,
  pointsFor,
  toPlayerQuestion,
  toReveal,
  answerFormat,
} = require("./quizScoring");

const PHASES = Object.freeze({
  LOBBY: "lobby",
  INTRO: "intro",
  QUESTION: "question",
  REVEAL: "reveal",
  LEADERBOARD: "leaderboard",
  FINISHED: "finished",
});

const DEFAULT_SETTINGS = Object.freeze({
  introMs: 3000,
  graceMs: 400,
  revealMs: 8000,
  leaderboardMs: 8000,
  autoAdvance: false,
  endWhenAllAnswered: true,
});

const MAX_EXTEND_SECONDS = 60;

class QuizGameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * One quiz night, held in memory. The server is the only authority: it owns the
 * question timer, accepts one answer per player, grades, scores and ranks.
 * Everything time-based goes through the injected clock/timer so it is testable.
 *
 * Emits: "change" (anything visible changed), "progress" (answer count moved),
 *        "locked" (a question was graded), "finished".
 */
class QuizGame extends EventEmitter {
  constructor({
    id,
    title = "",
    settings = {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
  }) {
    super();
    this.id = id;
    this.title = title;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;

    this.phase = PHASES.LOBBY;
    this.questions = [];
    this.index = -1;
    this.players = new Map();
    this.banned = new Set();

    this.answers = new Map();
    this.results = new Map();
    this.currentView = null;
    this.reveal = null;

    this.timer = null;
    this.phaseEndsAt = null;
    this.startedAt = null;
    this.endsAt = null;
    this.totalMs = 0;
    this.paused = false;
    this.pausedRemainingMs = 0;

    this.standings = [];
    this.cancelled = false;
    this.lastActivityAt = now();
  }

  // ------------------------------------------------------------ players

  addPlayer({ discordId, name, avatar = null }) {
    if (this.banned.has(discordId)) {
      throw new QuizGameError("removed", "You were removed from this quiz.");
    }
    if (this.phase === PHASES.FINISHED) {
      throw new QuizGameError("finished", "This quiz has finished.");
    }

    let player = this.players.get(discordId);
    if (!player && this.phase !== PHASES.LOBBY) {
      throw new QuizGameError("started", "This quiz has already started, so new players cannot join.");
    }
    if (player) {
      player.name = name || player.name;
      player.avatar = avatar ?? player.avatar;
    } else {
      player = {
        discordId,
        name: name || "Player",
        avatar,
        connected: false,
        score: 0,
        correctCount: 0,
        totalTimeMs: 0,
        lastGain: 0,
        rank: null,
        prevRank: null,
      };
      this.players.set(discordId, player);
      this.rank();
    }
    return player;
  }

  setConnected(discordId, connected) {
    const player = this.players.get(discordId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    this.touch();
    this.emit("change");
    if (connected === false) this.maybeLockForAllAnswered();
  }

  kick(discordId) {
    if (!this.players.delete(discordId)) return false;
    this.banned.add(discordId);
    this.answers.delete(discordId);
    this.rank();
    this.touch();
    this.emit("change");
    this.maybeLockForAllAnswered();
    return true;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((player) => player.connected);
  }

  // ------------------------------------------------------------ flow

  start(questions) {
    if (this.phase !== PHASES.LOBBY) throw new QuizGameError("bad_phase", "The quiz has already started.");
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new QuizGameError("no_questions", "This quiz has no questions.");
    }
    if (this.players.size === 0) throw new QuizGameError("no_players", "Wait for at least one player to join.");

    this.questions = questions;
    this.standings = this.computeStandings();
    this.startIntro(0);
  }

  /** Host "next": skips whatever the current step is waiting on. */
  next() {
    switch (this.phase) {
      case PHASES.INTRO:
        this.openQuestion();
        return;
      case PHASES.QUESTION:
        this.lockQuestion();
        return;
      case PHASES.REVEAL:
        this.afterReveal();
        return;
      case PHASES.LEADERBOARD:
        this.startIntro(this.index + 1);
        return;
      default:
        throw new QuizGameError("bad_phase", "There is nothing to skip right now.");
    }
  }

  pause() {
    if (this.phase !== PHASES.QUESTION || this.paused) {
      throw new QuizGameError("bad_phase", "Only a running question can be paused.");
    }
    this.cancelTimer();
    this.pausedRemainingMs = Math.max(0, this.endsAt - this.now());
    this.paused = true;
    this.touch();
    this.emit("change");
  }

  resume() {
    if (this.phase !== PHASES.QUESTION || !this.paused) {
      throw new QuizGameError("bad_phase", "The question is not paused.");
    }
    this.paused = false;
    this.endsAt = this.now() + this.pausedRemainingMs;
    this.scheduleLock();
    this.touch();
    this.emit("change");
  }

  extend(seconds) {
    if (this.phase !== PHASES.QUESTION || this.paused) {
      throw new QuizGameError("bad_phase", "Time can only be added to a running question.");
    }
    const added = Math.min(MAX_EXTEND_SECONDS, Math.max(1, Math.floor(Number(seconds) || 0)));
    this.endsAt += added * 1000;
    this.totalMs += added * 1000;
    this.scheduleLock();
    this.touch();
    this.emit("change");
  }

  /** Ends the quiz early; standings so far stand. */
  end({ cancelled = false } = {}) {
    if (this.phase === PHASES.FINISHED) return;
    if (this.phase === PHASES.QUESTION) this.gradeCurrent();
    this.cancelled = cancelled;
    this.finish();
  }

  startIntro(index) {
    this.index = index;
    this.phase = PHASES.INTRO;
    this.paused = false;
    this.answers = new Map();
    this.results = new Map();
    this.reveal = null;
    this.currentView = toPlayerQuestion(this.questions[index], { random: this.random });
    this.phaseEndsAt = this.now() + this.settings.introMs;
    this.schedule(this.settings.introMs, () => this.openQuestion());
    this.touch();
    this.emit("change");
  }

  openQuestion() {
    const question = this.questions[this.index];
    this.phase = PHASES.QUESTION;
    this.phaseEndsAt = null;
    this.paused = false;
    this.startedAt = this.now();
    this.totalMs = question.timeLimitSeconds * 1000;
    this.endsAt = this.startedAt + this.totalMs;
    this.scheduleLock();
    this.touch();
    this.emit("change");
  }

  scheduleLock() {
    this.schedule(Math.max(0, this.endsAt - this.now()) + this.settings.graceMs, () => this.lockQuestion());
  }

  submitAnswer(discordId, response) {
    const player = this.players.get(discordId);
    if (!player) throw new QuizGameError("not_playing", "You are not part of this quiz.");
    if (this.phase !== PHASES.QUESTION || this.paused) {
      throw new QuizGameError("closed", "This question is not taking answers.");
    }

    const received = this.now();
    if (received > this.endsAt + this.settings.graceMs) {
      throw new QuizGameError("late", "Time is up.");
    }
    if (this.answers.has(discordId)) {
      throw new QuizGameError("already_answered", "You already answered this question.");
    }

    const cleaned = normalizeResponse(this.questions[this.index], response);
    if (cleaned === null) throw new QuizGameError("invalid", "That answer is not valid for this question.");

    this.answers.set(discordId, { response: cleaned, receivedAt: received });
    this.touch();
    this.emit("progress", this.progressSnapshot());
    this.maybeLockForAllAnswered();
  }

  maybeLockForAllAnswered() {
    if (this.phase !== PHASES.QUESTION || this.paused || !this.settings.endWhenAllAnswered) return;
    const connected = this.connectedPlayers();
    if (connected.length === 0) return;
    if (connected.every((player) => this.answers.has(player.discordId))) this.lockQuestion();
  }

  lockQuestion() {
    if (this.phase !== PHASES.QUESTION) return;
    this.cancelTimer();
    this.gradeCurrent();
    this.phase = PHASES.REVEAL;
    this.paused = false;

    if (this.settings.autoAdvance) {
      this.phaseEndsAt = this.now() + this.settings.revealMs;
      this.schedule(this.settings.revealMs, () => this.afterReveal());
    } else {
      this.phaseEndsAt = null;
    }

    this.touch();
    this.emit("change");
  }

  gradeCurrent() {
    const question = this.questions[this.index];
    const previous = new Map(this.standings.map((entry) => [entry.discordId, entry.rank]));
    const verdictCounts = { correct: 0, partial: 0, wrong: 0, noAnswer: 0 };
    const choices = {};
    const responses = [];
    const locked = [];

    this.results = new Map();
    for (const player of this.players.values()) {
      const answer = this.answers.get(player.discordId);
      player.prevRank = previous.get(player.discordId) ?? null;

      if (!answer) {
        player.lastGain = 0;
        verdictCounts.noAnswer += 1;
        this.results.set(player.discordId, { answered: false, verdict: "none", fraction: 0, points: 0 });
        responses.push({ discordId: player.discordId, name: player.name, response: null, verdict: "none", points: 0 });
        continue;
      }

      const grade = gradeResponse(question, answer.response);
      const remaining = Math.max(0, this.endsAt - answer.receivedAt);
      const elapsedMs = Math.max(0, Math.min(this.totalMs, answer.receivedAt - this.startedAt));
      const points = pointsFor(question, grade.fraction, remaining, this.totalMs);

      player.score += points;
      player.lastGain = points;
      if (grade.verdict === "correct") player.correctCount += 1;
      if (points > 0) player.totalTimeMs += elapsedMs;
      verdictCounts[grade.verdict] += 1;

      const format = answerFormat(question);
      if (format === "single_choice") choices[answer.response] = (choices[answer.response] || 0) + 1;
      else if (format === "multi_select") answer.response.forEach((id) => { choices[id] = (choices[id] || 0) + 1; });
      else if (format === "true_false") choices[String(answer.response)] = (choices[String(answer.response)] || 0) + 1;

      const result = {
        answered: true,
        response: answer.response,
        verdict: grade.verdict,
        fraction: grade.fraction,
        points,
        elapsedMs,
      };
      this.results.set(player.discordId, result);
      responses.push({
        discordId: player.discordId,
        name: player.name,
        response: answer.response,
        verdict: grade.verdict,
        points,
      });
      locked.push({ discordId: player.discordId, name: player.name, ...result });
    }

    this.standings = this.computeStandings();
    this.reveal = { ...toReveal(question), verdictCounts, choices, responses };
    this.emit("locked", {
      index: this.index,
      question,
      results: locked,
      standings: this.standings,
    });
  }

  afterReveal() {
    if (this.phase !== PHASES.REVEAL) return;
    const isLast = this.index >= this.questions.length - 1;
    if (isLast) {
      this.finish();
      return;
    }

    const roundEnds = this.questions[this.index + 1].roundIndex !== this.questions[this.index].roundIndex;
    if (!roundEnds) {
      this.startIntro(this.index + 1);
      return;
    }

    this.phase = PHASES.LEADERBOARD;
    if (this.settings.autoAdvance) {
      this.phaseEndsAt = this.now() + this.settings.leaderboardMs;
      this.schedule(this.settings.leaderboardMs, () => this.startIntro(this.index + 1));
    } else {
      this.phaseEndsAt = null;
    }
    this.touch();
    this.emit("change");
  }

  finish() {
    this.cancelTimer();
    this.phase = PHASES.FINISHED;
    this.phaseEndsAt = null;
    this.paused = false;
    this.standings = this.computeStandings();
    this.touch();
    this.emit("change");
    this.emit("finished", { cancelled: this.cancelled, standings: this.standings });
  }

  // ------------------------------------------------------------ ranking

  computeStandings() {
    const ordered = [...this.players.values()].sort((a, b) =>
      b.score - a.score || a.totalTimeMs - b.totalTimeMs || a.name.localeCompare(b.name));

    let rank = 0;
    let previous = null;
    return ordered.map((player, position) => {
      if (!previous || previous.score !== player.score || previous.totalTimeMs !== player.totalTimeMs) {
        rank = position + 1;
      }
      previous = player;
      return {
        discordId: player.discordId,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        gain: player.lastGain,
        correctCount: player.correctCount,
        totalTimeMs: player.totalTimeMs,
        rank,
        rankChange: player.prevRank === null || player.prevRank === undefined ? 0 : player.prevRank - rank,
        connected: player.connected,
      };
    });
  }

  rank() {
    this.standings = this.computeStandings();
    for (const entry of this.standings) {
      const player = this.players.get(entry.discordId);
      if (player) player.rank = entry.rank;
    }
  }

  // ------------------------------------------------------------ timers

  schedule(ms, callback) {
    this.cancelTimer();
    this.timer = this.setTimer(callback, ms);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  cancelTimer() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  touch() {
    this.lastActivityAt = this.now();
  }

  dispose() {
    this.cancelTimer();
    this.removeAllListeners();
  }

  // ------------------------------------------------------------ views

  progressSnapshot() {
    const connected = this.connectedPlayers();
    return {
      answered: [...this.answers.keys()].filter((id) => this.players.has(id)).length,
      total: this.players.size,
      connected: connected.length,
    };
  }

  roundInfo() {
    const current = this.questions[this.index];
    if (!current) return null;
    const inRound = this.questions.filter((question) => question.roundIndex === current.roundIndex);
    return {
      index: current.roundIndex,
      title: current.roundTitle,
      questionNumber: inRound.indexOf(current) + 1,
      questionCount: inRound.length,
      roundCount: new Set(this.questions.map((question) => question.roundIndex)).size,
    };
  }

  /** State identical for everyone in the room. Never contains the solution before the reveal. */
  publicState() {
    const state = {
      id: this.id,
      title: this.title,
      phase: this.phase,
      serverNow: this.now(),
      cancelled: this.cancelled,
      settings: { autoAdvance: this.settings.autoAdvance },
      progress: this.progressSnapshot(),
      questionIndex: this.index,
      questionTotal: this.questions.length,
      round: this.roundInfo(),
      standings: this.standings,
      players: [...this.players.values()].map((player) => ({
        discordId: player.discordId,
        name: player.name,
        avatar: player.avatar,
        connected: player.connected,
      })),
    };

    if (this.phase === PHASES.INTRO) {
      const view = this.currentView || {};
      state.intro = {
        endsAt: this.phaseEndsAt,
        totalMs: this.settings.introMs,
        type: view.type || null,
        format: view.format || null,
        points: view.points ?? null,
      };
    }

    if (this.phase === PHASES.QUESTION || this.phase === PHASES.REVEAL) {
      state.question = this.currentView;
      state.timer = {
        startedAt: this.startedAt,
        endsAt: this.endsAt,
        totalMs: this.totalMs,
        paused: this.paused,
        remainingMs: this.paused ? this.pausedRemainingMs : Math.max(0, this.endsAt - this.now()),
      };
    }

    if (this.phase === PHASES.REVEAL) state.reveal = this.reveal;
    if (this.phaseEndsAt && (this.phase === PHASES.REVEAL || this.phase === PHASES.LEADERBOARD)) {
      state.nextAt = this.phaseEndsAt;
      state.holdMs = this.phase === PHASES.REVEAL ? this.settings.revealMs : this.settings.leaderboardMs;
    }

    return state;
  }

  /** What one player alone may know: their own answer, and their grade once it is revealed. */
  playerState(discordId) {
    const player = this.players.get(discordId);
    if (!player) return { joined: false };

    const answer = this.answers.get(discordId);
    const you = {
      joined: true,
      discordId,
      name: player.name,
      score: player.score,
      rank: player.rank,
      answered: Boolean(answer),
    };

    if (answer && this.phase === PHASES.QUESTION) you.response = answer.response;
    if (this.phase === PHASES.REVEAL || this.phase === PHASES.LEADERBOARD) {
      const result = this.results.get(discordId);
      if (result) you.result = result;
    }
    return you;
  }

  /** Extra detail for the host console and the big screen. */
  hostState() {
    const waitingOn = this.phase === PHASES.QUESTION
      ? this.connectedPlayers().filter((player) => !this.answers.has(player.discordId)).map((player) => player.name)
      : [];
    const current = this.questions[this.index];
    return {
      waitingOn,
      question: this.currentView,
      answer: current ? toReveal(current) : null,
    };
  }
}

module.exports = { DEFAULT_SETTINGS, PHASES, QuizGame, QuizGameError };
