const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
let server = http.createServer(app);
let io = new Server(server, { cors: { origin: "*" } });
const PORT = Number(process.env.PORT) || 3001;
const rooms = new Map();

// ─── Word Bank ───────────────────────────────────────────────────────────────
const WORDS = {
  Easy: {
    Objects: ["Umbrella","Bicycle","Mirror","Pillow","Backpack","Clock","Toothbrush","Candle"],
    Animals: ["Elephant","Rabbit","Dolphin","Penguin","Tiger","Giraffe"],
    Food:    ["Pizza","Mango","Sandwich","Pancake","Popcorn","Noodles"],
    Places:  ["Airport","Library","Beach","Hospital","Museum","School"],
  },
  Medium: {
    Objects: ["Compass","Thermos","Telescope","Lantern","Suitcase","Hourglass"],
    Animals: ["Chameleon","Flamingo","Octopus","Porcupine","Meerkat"],
    Food:    ["Lasagna","Avocado","Dumpling","Cinnamon","Pomegranate"],
    Places:  ["Lighthouse","Aquarium","Observatory","Stadium","Monastery"],
  },
  Hard: {
    Ideas:   ["Nostalgia","Gravity","Silence","Curiosity","Patience","Chaos"],
    Objects: ["Metronome","Kaleidoscope","Sundial","Periscope"],
    Places:  ["Greenhouse","Planetarium","Amphitheatre","Archive"],
    Nature:  ["Eclipse","Mirage","Avalanche","Tidepool"],
  },
};
const AVATARS = ["🦊","🐼","🐸","🦁","🐯","🐨","🐙","🦉"];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const BLOCKED_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "cunt", "motherfucker"];
function cleanName(s) {
  return String(s || "").replace(/[<>]/g, "").trim().slice(0, 15);
}
function hasProfanity(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return BLOCKED_WORDS.some((word) => normalized.includes(word));
}
function genCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function pickWord(difficulty) {
  const groups = WORDS[difficulty] || WORDS.Easy;
  const cats = Object.keys(groups);
  const cat = cats[Math.floor(Math.random() * cats.length)];
  const list = groups[cat];
  return { word: list[Math.floor(Math.random() * list.length)], category: cat };
}
function getPlayer(r, id) {
  return r.players.find((p) => p.id === id);
}
function alivePlayers(r) {
  return r.players.filter((p) => p.alive && p.connected);
}
function assignHost(r) {
  if (!getPlayer(r, r.hostId)?.connected) {
    const next = r.players.find((p) => p.connected);
    if (next) r.hostId = next.id;
  }
}

// ─── Public Room Projection (strips private data) ────────────────────────────
function publicRoom(r) {
  const reveal = ["reveal", "finished"].includes(r.phase);
  return {
    code: r.code,
    hostId: r.hostId,
    phase: r.phase,
    round: r.round,
    maxRounds: 3,
    settings: r.settings,
    players: r.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      alive: p.alive,
      connected: p.connected,
      host: p.id === r.hostId,
    })),
    clues: r.clues,
    discussionEndsAt: r.discussionEndsAt,
    votingEndsAt: r.votingEndsAt,
    duelGuessEndsAt: r.duelGuessEndsAt,
    finalGuessEndsAt: r.finalGuessEndsAt,
    votesRevealed: r.votesRevealed,
    voteCounts: r.votesRevealed ? r.votes : null,
    eliminatedId: r.eliminatedId,
    tiedIds: r.tiedIds,
    result: r.result,
    winner: r.winner,
    impostorId: reveal ? r.impostorId : undefined,
    secretWord: reveal ? r.word : undefined,
    category: reveal ? r.category : undefined,
  };
}

function emitRoom(r) {
  r.lastActivity = Date.now();
  io.to(r.code).emit("room:update", publicRoom(r));
}

// ─── Standard Mode ───────────────────────────────────────────────────────────
function startRound(r) {
  r.round++;
  r.phase = "clues";
  r.clues = [];
  r.votes = {};
  r.revote = false;
  r.tiedIds = null;
  r.votesRevealed = false;
  r.eliminatedId = null;
  r.result = null;
  r.winner = null;
  r.finalGuessEndsAt = null;
  r.duelGuessEndsAt = null;
  r.players.forEach((p) => (p.alive = true));

  const picked = pickWord(r.settings.difficulty);
  r.word = picked.word;
  r.category = picked.category;

  const pool = r.players.filter((p) => p.connected);
  r.impostorId = pool[Math.floor(Math.random() * pool.length)].id;
  r.turnOrder = pool.map((p) => p.id).sort(() => Math.random() - 0.5);
  r.turnIndex = 0;
  r.turnEndsAt = Date.now() + 30000;

  emitRoom(r);
  broadcastRoles(r);
  emitTurn(r);
}

function broadcastRoles(r) {
  r.players.forEach((p) => {
    io.to(p.id).emit("private:role", {
      role: p.id === r.impostorId ? "impostor" : "innocent",
      word: p.id === r.impostorId ? null : r.word,
      category: p.id === r.impostorId ? null : r.category,
      round: r.round,
    });
  });
}

function emitTurn(r) {
  const id = r.turnOrder[r.turnIndex];
  if (id) {
    r.turnEndsAt = Date.now() + 30000;
    io.to(r.code).emit("turn:current", { playerId: id, endsAt: r.turnEndsAt });
  }
}

function nextClue(r) {
  r.turnIndex++;
  if (r.turnIndex >= r.turnOrder.length) {
    r.phase = "discussion";
    r.discussionEndsAt = Date.now() + r.settings.discussionSeconds * 1000;
    emitRoom(r);
  } else {
    emitTurn(r);
    emitRoom(r);
  }
}

function finishRound(r, winner, reason) {
  r.phase = "reveal";
  r.winner = winner;
  r.result = reason;
  r.votesRevealed = true;
  if (winner === "innocents") {
    r.players.filter((p) => p.id !== r.impostorId).forEach((p) => (p.score += 5));
  } else {
    const imp = getPlayer(r, r.impostorId);
    if (imp) imp.score += 5;
  }
  emitRoom(r);
}

function startVote(r) {
  r.phase = "voting";
  r.votes = {};
  r.votesRevealed = false;
  r.votingEndsAt = Date.now() + 30000;
  emitRoom(r);
}

function resolveVote(r) {
  const counts = {};
  Object.values(r.votes).forEach((id) => (counts[id] = (counts[id] || 0) + 1));
  const max = Math.max(0, ...Object.values(counts));
  const tied = Object.keys(counts).filter((id) => counts[id] === max);
  r.votesRevealed = true;

  if (tied.length !== 1) {
    if (r.revote) {
      // Second tie — impostor wins, gets +3 for surviving
      const imp = getPlayer(r, r.impostorId);
      if (imp) imp.score += 3;
      finishRound(r, "impostor", "Second tie — the impostor survives!");
      return;
    }
    r.revote = true;
    r.phase = "revote";
    r.tiedIds = tied;
    r.votes = {};
    r.votingEndsAt = Date.now() + 20000;
    emitRoom(r);
    return;
  }

  const out = tied[0];
  // Award +2 to each voter who correctly voted for the impostor
  Object.keys(r.votes).forEach((voterId) => {
    if (out === r.impostorId && voterId !== r.impostorId) {
      const p = getPlayer(r, voterId);
      if (p) p.score += 2;
    }
  });

  const target = getPlayer(r, out);
  if (target) target.alive = false;
  r.eliminatedId = out;

  if (out === r.impostorId) {
    r.phase = "finalguess";
    r.finalGuessEndsAt = Date.now() + 30000;
    emitRoom(r);
    io.to(r.impostorId).emit("private:finalguess", {
      wordLength: r.word.length,
      endsAt: r.finalGuessEndsAt,
    });
    return;
  }

  const remaining = alivePlayers(r);
  if (remaining.filter((p) => p.id !== r.impostorId).length === 0 || remaining.length <= 2) {
    finishRound(r, "impostor", "The impostor outlasted the innocents!");
    return;
  }

  // Innocent eliminated but game continues — show brief reveal then resume
  r.phase = "reveal";
  r.result = `${target?.name || "A player"} was eliminated. The game continues next round.`;
  emitRoom(r);
}

// ─── Duel Mode ───────────────────────────────────────────────────────────────
function startDuelRound(r) {
  r.round++;
  r.phase = "duel_clue";
  r.clues = [];
  r.votes = {};
  r.revote = false;
  r.tiedIds = null;
  r.votesRevealed = false;
  r.eliminatedId = null;
  r.result = null;
  r.winner = null;
  r.finalGuessEndsAt = null;
  r.duelGuessEndsAt = null;
  r.players.forEach((p) => (p.alive = true));

  const picked = pickWord(r.settings.difficulty);
  r.word = picked.word;
  r.category = picked.category;

  // Roles alternate each round
  const pool = r.players.filter((p) => p.connected);
  const seed = (r.duelImpostorSeed ?? 0) % pool.length;
  r.impostorId = pool[seed].id;

  // Only the innocent gives a clue
  const innocentId = pool.find((p) => p.id !== r.impostorId)?.id;
  r.turnOrder = innocentId ? [innocentId] : [];
  r.turnIndex = 0;
  r.turnEndsAt = Date.now() + 30000;

  emitRoom(r);
  broadcastRoles(r);

  if (r.turnOrder.length > 0) {
    io.to(r.code).emit("turn:current", { playerId: r.turnOrder[0], endsAt: r.turnEndsAt });
  }
}

function finishDuelRound(r, winner, reason) {
  r.phase = "reveal";
  r.winner = winner;
  r.result = reason;
  r.votesRevealed = true;
  if (winner === "innocents") {
    const innocent = r.players.find((p) => p.id !== r.impostorId);
    if (innocent) innocent.score += 3;
  } else {
    const imp = getPlayer(r, r.impostorId);
    if (imp) imp.score += 5;
  }
  emitRoom(r);
}

// ─── Socket Handlers ─────────────────────────────────────────────────────────
function registerSocketHandlers() {
  io.on("connection", (socket) => {

    // ── B1: Reconnection via session token ──────────────────────────────────
    const { sessionId } = socket.handshake.auth || {};
    if (sessionId) {
      for (const r of rooms.values()) {
        const p = r.players.find((pl) => pl.sessionId === sessionId && !pl.connected);
        if (p) {
          const oldId = p.id;

          // Remap all server-side IDs
          p.id = socket.id;
          p.connected = true;
          p.disconnectedAt = null;

          if (r.impostorId === oldId) r.impostorId = socket.id;
          if (r.hostId === oldId) r.hostId = socket.id;
          if (r.turnOrder) {
            const ti = r.turnOrder.indexOf(oldId);
            if (ti !== -1) r.turnOrder[ti] = socket.id;
          }
          // Remap vote keys and values
          const newVotes = {};
          for (const [k, v] of Object.entries(r.votes || {})) {
            newVotes[k === oldId ? socket.id : k] = v === oldId ? socket.id : v;
          }
          r.votes = newVotes;

          socket.join(r.code);
          emitRoom(r);

          // Re-send private game state
          const inProgress = !["lobby", "reveal", "finished"].includes(r.phase);
          if (inProgress) {
            socket.emit("private:role", {
              role: socket.id === r.impostorId ? "impostor" : "innocent",
              word: socket.id === r.impostorId ? null : r.word,
              category: socket.id === r.impostorId ? null : r.category,
              round: r.round,
            });
          }
          if (r.phase === "finalguess" && socket.id === r.impostorId) {
            socket.emit("private:finalguess", { wordLength: r.word.length, endsAt: r.finalGuessEndsAt });
          }
          if (r.phase === "duel_guess" && socket.id === r.impostorId) {
            socket.emit("private:duelguess", { endsAt: r.duelGuessEndsAt });
          }
          if (["clues", "duel_clue"].includes(r.phase)) {
            const cur = r.turnOrder?.[r.turnIndex];
            if (cur) io.to(r.code).emit("turn:current", { playerId: cur, endsAt: r.turnEndsAt });
          }
          // Restore chat history
          if (r.chat?.length) socket.emit("chat:history", r.chat);

          socket.emit("notice", "Welcome back! You have been reconnected.");
          break;
        }
      }
    }

    // ── Create Room ─────────────────────────────────────────────────────────
    socket.on("room:create", ({ name, avatar, settings = {}, sid } = {}, cb = () => {}) => {
      const n = cleanName(name);
      if (n.length < 3) return cb({ ok: false, error: "Nickname must be 3–15 characters." });
      if (hasProfanity(n)) return cb({ ok: false, error: "Please choose a nickname without inappropriate language." });

      let c = genCode();
      while (rooms.has(c)) c = genCode();

      const p = {
        id: socket.id,
        sessionId: sid || sessionId || null,
        name: n,
        avatar: AVATARS.includes(avatar) ? avatar : AVATARS[0],
        score: 0,
        alive: true,
        connected: true,
      };
      const r = {
        code: c,
        hostId: socket.id,
        players: [p],
        phase: "lobby",
        round: 0,
        settings: {
          difficulty: ["Easy","Medium","Hard"].includes(settings.difficulty) ? settings.difficulty : "Easy",
          language: settings.language || "English",
          discussionSeconds: [60, 90, 120].includes(+settings.discussionSeconds) ? +settings.discussionSeconds : 60,
          duelMode: !!settings.duelMode,
        },
        clues: [],
        votes: {},
        revote: false,
        chat: [],
        lastActivity: Date.now(),
      };
      rooms.set(c, r);
      socket.join(c);
      cb({ ok: true, code: c });
      emitRoom(r);
    });

    // ── Join Room ────────────────────────────────────────────────────────────
    socket.on("room:join", ({ code: c, name, avatar, sid } = {}, cb = () => {}) => {
      const r = rooms.get(String(c || "").toUpperCase());
      if (!r) return cb({ ok: false, error: "Room not found." });
      if (r.phase !== "lobby") return cb({ ok: false, error: "This game has already started." });
      if (r.players.length >= 8) return cb({ ok: false, error: "Room is full (8 players max)." });

      const n = cleanName(name);
      if (n.length < 3) return cb({ ok: false, error: "Nickname must be 3–15 characters." });
      if (hasProfanity(n)) return cb({ ok: false, error: "Please choose a nickname without inappropriate language." });

      const duplicateName = r.players.some((p) => p.name.toLowerCase() === n.toLowerCase());
      let displayName = n;
      if (r.players.some((p) => p.name.toLowerCase() === displayName.toLowerCase())) {
        displayName = `${displayName.slice(0, 12)}${r.players.length + 1}`;
      }

      const p = {
        id: socket.id,
        sessionId: sid || sessionId || null,
        name: displayName,
        avatar: AVATARS.includes(avatar) ? avatar : AVATARS[r.players.length % AVATARS.length],
        score: 0,
        alive: true,
        connected: true,
      };
      r.players.push(p);
      socket.join(r.code);
      cb({ ok: true, code: r.code, renamed: duplicateName, displayName });
      emitRoom(r);
    });

    // ── Explicitly leave a room (clears the reconnectable player slot) ───────
    socket.on("room:leave", ({ code: c } = {}, cb = () => {}) => {
      const code = String(c || "").toUpperCase();
      const r = rooms.get(code);
      if (!r) {
        socket.leave(code);
        return cb({ ok: true });
      }

      const player = getPlayer(r, socket.id);
      if (!player) {
        socket.leave(code);
        return cb({ ok: true });
      }

      const leavingId = player.id;
      const wasAlive = player.alive;
      const wasImpostor = leavingId === r.impostorId;
      const phase = r.phase;

      // Remove the player completely so the saved session cannot reconnect them.
      r.players = r.players.filter((p) => p.id !== leavingId);
      delete r.votes[leavingId];
      Object.keys(r.votes).forEach((voterId) => {
        if (r.votes[voterId] === leavingId) delete r.votes[voterId];
      });
      if (r.tiedIds) r.tiedIds = r.tiedIds.filter((id) => id !== leavingId);
      if (r.turnOrder) {
        const oldIndex = r.turnOrder.indexOf(leavingId);
        if (oldIndex !== -1) {
          r.turnOrder.splice(oldIndex, 1);
          if (oldIndex < r.turnIndex) r.turnIndex--;
        }
      }

      socket.leave(code);
      r.lastActivity = Date.now();

      if (!r.players.length) {
        rooms.delete(code);
        cb({ ok: true });
        return;
      }

      assignHost(r);

      if (!["lobby", "reveal", "finished"].includes(phase) && wasAlive) {
        if (r.settings.duelMode) {
          finishDuelRound(r, wasImpostor ? "innocents" : "impostor", `${player.name} left the game.`);
        } else if (wasImpostor) {
          finishRound(r, "innocents", "The impostor left the game.");
        } else if (!r.players.some((p) => p.id === r.impostorId && p.connected)) {
          finishRound(r, "innocents", "The impostor disconnected and did not return.");
        } else if (alivePlayers(r).length <= 2) {
          finishRound(r, "impostor", "The impostor outlasted the remaining innocents.");
        } else if (phase === "clues") {
          if (r.turnIndex >= r.turnOrder.length) {
            r.phase = "discussion";
            r.discussionEndsAt = Date.now() + r.settings.discussionSeconds * 1000;
            emitRoom(r);
          } else {
            emitTurn(r);
            emitRoom(r);
          }
        } else if (["voting", "revote"].includes(phase)) {
          const voters = alivePlayers(r);
          if (voters.length && voters.every((p) => r.votes[p.id])) resolveVote(r);
          else emitRoom(r);
        } else {
          emitRoom(r);
        }
      } else {
        emitRoom(r);
      }

      cb({ ok: true });
    });

    // ── Host kick (lobby only) ────────────────────────────────────────────────
    socket.on("player:kick", ({ code: c, playerId } = {}, cb = () => {}) => {
      const r = rooms.get(String(c || "").toUpperCase());
      if (!r || r.hostId !== socket.id || r.phase !== "lobby") return cb({ ok: false, error: "Only the host can remove players from the lobby." });
      const target = getPlayer(r, playerId);
      if (!target || target.id === socket.id) return cb({ ok: false, error: "Player cannot be removed." });
      r.players = r.players.filter((p) => p.id !== playerId);
      const targetSocket = io.sockets.sockets.get(playerId);
      if (targetSocket) { targetSocket.emit("room:kicked", "The host removed you from the room."); targetSocket.leave(r.code); }
      emitRoom(r);
      cb({ ok: true });
    });

    // ── Start Game ───────────────────────────────────────────────────────────
    socket.on("match:start", ({ code: c } = {}) => {
      const r = rooms.get(c);
      if (!r || r.hostId !== socket.id || r.phase !== "lobby") return;

      const connected = r.players.filter((p) => p.connected).length;

      if (r.settings.duelMode) {
        if (connected !== 2)
          return socket.emit("error:message", "Duel Mode requires exactly 2 players.");
        r.round = 0;
        r.duelImpostorSeed = Math.floor(Math.random() * 2);
        r.players.forEach((p) => (p.score = 0));
        startDuelRound(r);
      } else {
        if (connected < 3)
          return socket.emit("error:message", "Standard Mode requires at least 3 players.");
        r.round = 0;
        r.players.forEach((p) => (p.score = 0));
        startRound(r);
      }
    });

    // ── Clue Submit ──────────────────────────────────────────────────────────
    socket.on("clue:submit", ({ code: c, text } = {}) => {
      const r = rooms.get(String(c || "").toUpperCase());
      if (!r || !["clues", "duel_clue"].includes(r.phase)) return;
      if (r.turnOrder[r.turnIndex] !== socket.id) return;
      const clue = String(text || "").trim().slice(0, 100);
      if (!clue) return;

      r.clues.push({ playerId: socket.id, name: getPlayer(r, socket.id)?.name, text: clue });
      io.to(r.code).emit("clue:new", r.clues[r.clues.length - 1]);

      if (r.phase === "duel_clue") {
        // After innocent gives their clue → impostor guesses
        r.phase = "duel_guess";
        r.duelGuessEndsAt = Date.now() + 30000;
        emitRoom(r);
        io.to(r.impostorId).emit("private:duelguess", { endsAt: r.duelGuessEndsAt });
      } else {
        nextClue(r);
      }
    });

    // ── Discussion Chat ──────────────────────────────────────────────────────
    socket.on("discussion:chat", ({ code: c, text } = {}) => {
      const r = rooms.get(c);
      if (!r || r.phase !== "discussion" || !getPlayer(r, socket.id)?.alive) return;
      const msg = String(text || "").trim().slice(0, 250);
      if (!msg) return;
      const item = {
        id: crypto.randomUUID(),
        playerId: socket.id,
        name: getPlayer(r, socket.id).name,
        text: msg,
        at: Date.now(),
      };
      r.chat.push(item);
      io.to(r.code).emit("chat:new", item);
    });

    // ── Start Vote (host triggers) ───────────────────────────────────────────
    socket.on("discussion:vote", ({ code: c } = {}) => {
      const r = rooms.get(c);
      if (!r || r.hostId !== socket.id || r.phase !== "discussion") return;
      startVote(r);
    });

    // ── Cast Vote ────────────────────────────────────────────────────────────
    socket.on("vote:cast", ({ code: c, targetId } = {}) => {
      const r = rooms.get(c);
      if (!r || !["voting", "revote"].includes(r.phase)) return;
      const voter = getPlayer(r, socket.id);
      if (!voter || !voter.alive || !voter.connected) return; // security: no votes from disconnected or eliminated players
      if (socket.id === targetId) return;          // no self-vote
      if (r.votes[socket.id]) return;              // no double-vote
      if (r.phase === "revote" && !r.tiedIds?.includes(targetId)) return;
      if (!alivePlayers(r).some((p) => p.id === targetId)) return; // target must be alive & connected

      r.votes[socket.id] = targetId;
      io.to(r.code).emit("vote:progress", {
        count: Object.keys(r.votes).length,
        total: alivePlayers(r).length,
      });
      if (Object.keys(r.votes).length >= alivePlayers(r).length) resolveVote(r);
    });

    // ── Force-End Vote (host) ────────────────────────────────────────────────
    socket.on("vote:finish", ({ code: c } = {}) => {
      const r = rooms.get(c);
      // Validate host and phase first
      if (!r || r.hostId !== socket.id || !["voting", "revote"].includes(r.phase)) return;
      // Guard: don't resolve with zero votes
      if (Object.keys(r.votes).length === 0) return;
      resolveVote(r);
    });

    // ── Final Guess — Standard Mode ──────────────────────────────────────────
    socket.on("finalguess:submit", ({ code: c, guess } = {}) => {
      const r = rooms.get(c);
      if (!r || r.phase !== "finalguess" || socket.id !== r.impostorId) return;
      const g = String(guess || "").trim();
      if (!g) return;
      const correct = g.toLowerCase() === r.word.toLowerCase();
      if (correct) {
        const imp = getPlayer(r, r.impostorId);
        if (imp) imp.score += 5;
      }
      finishRound(
        r,
        correct ? "impostor" : "innocents",
        correct ? "The impostor guessed the secret word!" : "The impostor guessed incorrectly."
      );
    });

    // ── Duel Guess ───────────────────────────────────────────────────────────
    socket.on("duelguess:submit", ({ code: c, guess } = {}) => {
      const r = rooms.get(c);
      if (!r || r.phase !== "duel_guess" || socket.id !== r.impostorId) return;
      const g = String(guess || "").trim();
      if (!g) return;
      const correct = g.toLowerCase() === r.word.toLowerCase();
      finishDuelRound(
        r,
        correct ? "impostor" : "innocents",
        correct ? "🎯 The impostor guessed the secret word!" : "❌ The impostor guessed wrong — innocents win!"
      );
    });

    // ── Next Round ───────────────────────────────────────────────────────────
    socket.on("round:next", ({ code: c } = {}) => {
      const r = rooms.get(c);
      if (!r || r.hostId !== socket.id || r.phase !== "reveal") return;
      if (r.round >= 3) {
        r.phase = "finished";
        emitRoom(r);
      } else {
        r.chat = [];
        if (r.settings.duelMode) {
          r.duelImpostorSeed = (r.duelImpostorSeed ?? 0) + 1;
          startDuelRound(r);
        } else {
          r.revote = false;
          startRound(r);
        }
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      for (const r of rooms.values()) {
        const p = getPlayer(r, socket.id);
        if (p) {
          p.connected = false;
          p.disconnectedAt = Date.now();
          assignHost(r);
          emitRoom(r);
          // Disconnected players are excluded from the electorate immediately.
          if (["voting", "revote"].includes(r.phase)) {
            const voters = alivePlayers(r);
            if (voters.length && voters.every((v) => r.votes[v.id])) resolveVote(r);
          }
          // Remove empty lobby rooms immediately
          if (r.phase === "lobby" && !r.players.some((x) => x.connected)) {
            rooms.delete(r.code);
          }
        }
      }
    });
  });
}

// ─── Cleanup & Timer Loop ─────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms.entries()) {
    // B7: Delete rooms inactive for 30 minutes
    if (r.lastActivity && now - r.lastActivity > 30 * 60 * 1000) {
      rooms.delete(code);
      continue;
    }
    // B2: Delete finished rooms where everyone has been disconnected for > 5 min
    if (
      ["reveal", "finished"].includes(r.phase) &&
      r.players.every((p) => !p.connected) &&
      r.players.every((p) => now - (p.disconnectedAt || 0) > 5 * 60 * 1000)
    ) {
      rooms.delete(code);
      continue;
    }
    // Expire disconnected players after a 60-second reconnect grace period.
    const expired = r.players.filter((p) => !p.connected && p.disconnectedAt && now - p.disconnectedAt > 60000);
    for (const p of expired) {
      const wasImpostor = p.id === r.impostorId;
      const wasAlive = p.alive;
      r.players = r.players.filter((x) => x.id !== p.id);
      delete r.votes[p.id];
      Object.keys(r.votes).forEach((voterId) => { if (r.votes[voterId] === p.id) delete r.votes[voterId]; });
      if (r.tiedIds) r.tiedIds = r.tiedIds.filter((id) => id !== p.id);
      if (r.turnOrder) {
        const idx = r.turnOrder.indexOf(p.id);
        if (idx !== -1) { r.turnOrder.splice(idx, 1); if (idx < r.turnIndex) r.turnIndex--; }
      }
      assignHost(r);
      if (wasAlive && !["lobby", "reveal", "finished"].includes(r.phase)) {
        if (wasImpostor) { finishRound(r, "innocents", "The impostor did not reconnect within 60 seconds."); break; }
        if (!r.players.some((x) => x.id === r.impostorId && x.connected)) { finishRound(r, "innocents", "The impostor disconnected and did not return."); break; }
        if (alivePlayers(r).length <= 2) { finishRound(r, "impostor", "The impostor outlasted the remaining innocents."); break; }
        if (["voting", "revote"].includes(r.phase)) {
          const voters = alivePlayers(r);
          if (voters.length && voters.every((v) => r.votes[v.id])) { resolveVote(r); break; }
        }
      }
      emitRoom(r);
    }
    // B1 complement: auto-skip disconnected player's turn after 60 s
    if (["clues", "duel_clue"].includes(r.phase)) {
      const curId = r.turnOrder?.[r.turnIndex];
      const curPlayer = getPlayer(r, curId);
      if (curPlayer && !curPlayer.connected && curPlayer.disconnectedAt && now - curPlayer.disconnectedAt > 60000) {
        if (r.phase === "duel_clue") {
          r.phase = "duel_guess";
          r.duelGuessEndsAt = Date.now() + 30000;
          emitRoom(r);
          if (r.impostorId) io.to(r.impostorId).emit("private:duelguess", { endsAt: r.duelGuessEndsAt });
        } else {
          nextClue(r);
        }
        continue;
      }
    }

    // Phase timers
    if (r.phase === "clues" && r.turnEndsAt && now >= r.turnEndsAt) {
      nextClue(r);
    } else if (r.phase === "duel_clue" && r.turnEndsAt && now >= r.turnEndsAt) {
      r.phase = "duel_guess";
      r.duelGuessEndsAt = Date.now() + 30000;
      emitRoom(r);
      if (r.impostorId) io.to(r.impostorId).emit("private:duelguess", { endsAt: r.duelGuessEndsAt });
    } else if (r.phase === "discussion" && r.discussionEndsAt && now >= r.discussionEndsAt) {
      startVote(r);
    } else if (["voting", "revote"].includes(r.phase) && r.votingEndsAt && now >= r.votingEndsAt) {
      resolveVote(r);
    } else if (r.phase === "finalguess" && r.finalGuessEndsAt && now >= r.finalGuessEndsAt) {
      finishRound(r, "innocents", "The impostor ran out of time to guess.");
    } else if (r.phase === "duel_guess" && r.duelGuessEndsAt && now >= r.duelGuessEndsAt) {
      finishDuelRound(r, "innocents", "The impostor ran out of time!");
    }
  }
}, 1000);

// ─── Static File Serving ──────────────────────────────────────────────────────
const distDir = path.join(__dirname, "../client/dist");
const clientIndex = path.join(distDir, "index.html");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/socket\.io).*$/, (req, res) => res.sendFile(clientIndex));
}

// ─── Server Boot ──────────────────────────────────────────────────────────────
function startServer(port) {
  if (server.listening) server.close();
  const nextServer = http.createServer(app);
  io = new Server(nextServer, { cors: { origin: "*" } });
  registerSocketHandlers();
  server = nextServer;
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE") { startServer(port + 1); return; }
    throw err;
  });
  server.listen(port, () => console.log(`Find the Impostor server listening on ${port}`));
}

startServer(PORT);
