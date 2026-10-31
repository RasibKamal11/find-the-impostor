import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './style.css';

// ─── Session Token (B1: Reconnection) ────────────────────────────────────────
function getSessionId() {
  let sid = localStorage.getItem('fti_session');
  if (!sid) {
    sid = crypto.randomUUID();
    localStorage.setItem('fti_session', sid);
  }
  return sid;
}
const SESSION_ID = getSessionId();
const socket = io({ auth: { sessionId: SESSION_ID } });

// ─── Audio System (Step 5) ────────────────────────────────────────────────────
class AudioManager {
  constructor() {
    this.ctx = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.masterGain = null;
    this.musicPlaying = false;
    this.sfxVol = 0.6;
    this.musicVol = 0.25;
    this.muted = false;
  }
  _init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVol;
    this.sfxGain.connect(this.masterGain);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicVol;
    this.musicGain.connect(this.masterGain);
  }
  _tone(freq, dur = 0.12, type = 'sine', vol = 0.28) {
    if (this.muted || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start();
    osc.stop(this.ctx.currentTime + dur);
  }
  wake() { this._init(); }
  join()  { this._init(); [523,659,784].forEach((f,i) => setTimeout(() => this._tone(f, 0.12), i*90)); }
  clue()  { this._init(); this._tone(440, 0.14, 'sine', 0.22); }
  vote()  { this._init(); this._tone(350, 0.1, 'triangle', 0.2); }
  error() { this._init(); this._tone(200, 0.3, 'sawtooth', 0.2); }
  tick()  { this._init(); this._tone(900, 0.05, 'square', 0.12); }
  win()   {
    this._init();
    [[523,0],[659,130],[784,260],[1047,400]].forEach(([f,d]) => setTimeout(() => this._tone(f, 0.3), d));
  }
  setMuted(v)    { this.muted = v; if (this.masterGain) this.masterGain.gain.value = v ? 0 : 1; }
  setSfxVol(v)   { this.sfxVol = v; if (this.sfxGain) this.sfxGain.gain.value = v; }
  setMusicVol(v) { this.musicVol = v; if (this.musicGain) this.musicGain.gain.value = v; }

  startMusic() {
    this._init();
    if (this.musicPlaying) return;
    this.musicPlaying = true;
    this._musicLoop();
  }
  stopMusic() { this.musicPlaying = false; }

  _musicLoop() {
    if (!this.musicPlaying || !this.ctx) return;
    const chords = [[220,277,330],[196,247,294],[175,220,261],[207,261,311]];
    const chord = chords[Math.floor(Math.random() * chords.length)];
    chord.forEach(freq => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, this.ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.07, this.ctx.currentTime + 0.6);
      g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 3.5);
      osc.connect(g);
      g.connect(this.musicGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 4);
    });
    setTimeout(() => this._musicLoop(), 3400);
  }
}
const audio = new AudioManager();

// ─── Avatars ──────────────────────────────────────────────────────────────────
const AVATARS = ['🦊','🐼','🐸','🦁','🐯','🐨','🐙','🦉'];

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  // Setup state
  const [name, setName]           = useState('');
  const [avatar, setAvatar]       = useState('🦊');
  const [roomCode, setRoomCode]   = useState('');
  const [settings, setSettings]   = useState({ difficulty: 'Easy', discussionSeconds: 60, duelMode: false });

  // Game state
  const [room, setRoom]           = useState(null);
  const [role, setRole]           = useState(null);
  const [word, setWord]           = useState(null);
  const [category, setCategory]   = useState(null);
  const [turn, setTurn]           = useState(null);
  const [chat, setChat]           = useState([]);
  const [progress, setProgress]   = useState(null);

  // Input state
  const [clue, setClue]           = useState('');
  const [message, setMessage]     = useState('');
  const [guess, setGuess]         = useState('');
  const [duelGuess, setDuelGuess] = useState('');

  // UI state
  const [notice, setNotice]       = useState('');
  const [time, setTime]           = useState(0);
  const [nameError, setNameError] = useState('');

  // Audio state
  const [muted, setMuted]         = useState(false);
  const [sfxVol, setSfxVol]       = useState(0.6);
  const [musicVol, setMusicVol]   = useState(0.25);
  const [musicOn, setMusicOn]     = useState(false);

  const chatEndRef = useRef(null);

  // ── Socket events ────────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('room:update', (r) => {
      setRoom(prev => {
        // Only fire win sound when winner transitions from null → a value
        if ((r.phase === 'reveal' || r.phase === 'finished') && r.winner && !prev?.winner) {
          audio.win();
          audio.stopMusic();
        }
        return r;
      });
    });
    socket.on('private:role', (d) => {
      setRole(d.role);
      setWord(d.word);
      setCategory(d.category);
      setGuess('');
      setDuelGuess('');
    });
    socket.on('turn:current', (d) => setTurn(d));
    socket.on('chat:new', (m) => setChat(a => [...a, m]));
    socket.on('chat:history', (msgs) => setChat(msgs));
    // B1 fix: clue:new no longer mutates room.clues client-side.
    // room:update (emitted right after every clue submission) carries the
    // full authoritative clues array, preventing duplicate entries on reconnect.
    socket.on('clue:new', () => audio.clue());
    socket.on('vote:progress', setProgress);
    socket.on('error:message', (msg) => { setNotice(msg); audio.error(); });
    socket.on('notice', setNotice);
    socket.on('room:kicked', (msg) => { localStorage.removeItem('fti_session'); setRoom(null); setRole(null); setWord(null); setCategory(null); setNotice(msg || 'You were removed from the room.'); });
    socket.on('private:finalguess', () => {});   // timer via publicRoom state
    socket.on('private:duelguess', () => {});    // timer via publicRoom state
    return () => socket.removeAllListeners();
  }, []);

  // ── Timer countdown ──────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      let endsAt = null;
      if (turn?.endsAt && room?.phase === 'clues') endsAt = turn.endsAt;
      else if (room?.phase === 'duel_clue' && turn?.endsAt)  endsAt = turn.endsAt;
      else if (room?.phase === 'duel_guess' && room.duelGuessEndsAt) endsAt = room.duelGuessEndsAt;
      else if (room?.phase === 'discussion' && room.discussionEndsAt) endsAt = room.discussionEndsAt;
      else if (room?.phase === 'voting' && room.votingEndsAt)    endsAt = room.votingEndsAt;
      else if (room?.phase === 'revote' && room.votingEndsAt)    endsAt = room.votingEndsAt;
      else if (room?.phase === 'finalguess' && room.finalGuessEndsAt) endsAt = room.finalGuessEndsAt;
      const t = endsAt ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : 0;
      setTime(t);
      if (t <= 5 && t > 0 && endsAt) audio.tick();
    }, 500);
    return () => clearInterval(id);
  }, [turn, room]);

  // ── Auto-scroll chat ─────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  // ── Nickname validation (B4) ─────────────────────────────────────────────
  const validateName = useCallback((v) => {
    if (!v.trim())           return setNameError('');
    if (v.trim().length < 3) return setNameError('At least 3 characters required');
    if (v.trim().length > 15) return setNameError('Max 15 characters');
    setNameError('');
  }, []);

  const nameOk = name.trim().length >= 3 && name.trim().length <= 15;

  // ── Actions ──────────────────────────────────────────────────────────────
  const create = () => {
    audio.wake();
    socket.emit('room:create', { name, avatar, settings, sid: SESSION_ID }, (r) => {
      if (r.ok) { setRoomCode(r.code); setNotice('Room created! Share the code.'); audio.join(); }
      else      { setNotice(r.error); audio.error(); }
    });
  };
  const join = () => {
    audio.wake();
    socket.emit('room:join', { code: roomCode, name, avatar, sid: SESSION_ID }, (r) => {
      if (r.ok) { setNotice(r.renamed ? `That nickname was already taken. Your name is now ${r.displayName}.` : 'Joined!'); audio.join(); }
      else      { setNotice(r.error); audio.error(); }
    });
  };
  const kickPlayer = (playerId) => {
    socket.emit('player:kick', { code: room.code, playerId }, (r) => {
      if (!r?.ok) setNotice(r?.error || 'Could not remove that player.');
      else setNotice('Player removed from the lobby.');
    });
  };

  const leaveGame = () => {
    const code = room?.code;
    const resetLocalGame = () => {
      localStorage.removeItem('fti_session');
      setRoom(null);
      setRole(null);
      setWord(null);
      setCategory(null);
      setTurn(null);
      setChat([]);
      setProgress(null);
      setClue('');
      setMessage('');
      setGuess('');
      setDuelGuess('');
      setRoomCode('');
      setNotice('You left the game.');
      audio.stopMusic();
      setMusicOn(false);
    };
    if (!code) return resetLocalGame();
    socket.emit('room:leave', { code }, (result) => {
      if (result?.ok) resetLocalGame();
      else setNotice('Could not leave the room. Please try again.');
    });
  };

  const sendClue = () => {
    socket.emit('clue:submit', { code: room.code, text: clue });
    setClue('');
    audio.clue();
  };
  const sendChat = () => {
    if (!message.trim()) return;
    socket.emit('discussion:chat', { code: room.code, text: message });
    setMessage('');
  };
  const castVote = (targetId) => {
    socket.emit('vote:cast', { code: room.code, targetId });
    audio.vote();
  };
  const submitFinalGuess = () => {
    if (!guess.trim()) return;
    socket.emit('finalguess:submit', { code: room.code, guess });
  };
  const submitDuelGuess = () => {
    if (!duelGuess.trim()) return;
    socket.emit('duelguess:submit', { code: room.code, guess: duelGuess });
  };

  // ── Music toggle ─────────────────────────────────────────────────────────
  const toggleMusic = () => {
    audio.wake();
    if (musicOn) { audio.stopMusic(); setMusicOn(false); }
    else         { audio.startMusic(); setMusicOn(true); }
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    audio.setMuted(next);
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const me      = room?.players.find(p => p.id === socket.id);
  const isHost  = me?.host;
  const active  = room?.players.filter(p => p.alive && p.connected) || [];
  const isDuel  = room?.settings?.duelMode;
  const timedPhases = ['clues','duel_clue','duel_guess','discussion','voting','revote','finalguess'];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main>
      <header>
        <div className="brand">🕵️ <span>FIND THE <b>IMPOSTOR</b></span></div>
        <div className="header-right">
          {/* Audio Controls */}
          <div className="audio-controls">
            <button className={`audio-btn ${musicOn ? 'active' : ''}`} onClick={toggleMusic} title="Background Music">🎵</button>
            <button className={`audio-btn ${muted ? 'muted' : ''}`} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
              {muted ? '🔇' : '🔊'}
            </button>
            <div className="vol-sliders">
              <label>SFX</label>
              <input type="range" min="0" max="1" step="0.05" value={sfxVol}
                onChange={e => { const v = +e.target.value; setSfxVol(v); audio.setSfxVol(v); audio.wake(); }} />
              <label>Music</label>
              <input type="range" min="0" max="1" step="0.05" value={musicVol}
                onChange={e => { const v = +e.target.value; setMusicVol(v); audio.setMusicVol(v); audio.wake(); }} />
            </div>
          </div>
          <div className="tag">ONLINE SOCIAL DEDUCTION</div>
        </div>
      </header>

      {/* ═══════════════════════════ WELCOME SCREEN ══════════════════════════ */}
      {!room ? (
        <section className="welcome">
          <div className="eyebrow">THINK FAST. TRUST NO ONE.</div>
          <h1>Can you find<br /><em>the impostor?</em></h1>
          <p className="sub">A multiplayer mystery game. Give clues, discuss, and uncover who's hiding in plain sight.</p>

          <div className="panel setup">
            <label>Your nickname</label>
            <input
              value={name}
              maxLength="15"
              onChange={e => { setName(e.target.value); validateName(e.target.value); }}
              placeholder="Enter a nickname (3–15 chars)"
            />
            {nameError && <p className="name-error">{nameError}</p>}

            <label>Choose your avatar</label>
            <div className="avatars">
              {AVATARS.map(a => (
                <button key={a} className={avatar === a ? 'selected' : ''} onClick={() => setAvatar(a)}>{a}</button>
              ))}
            </div>

            <div className="settings">
              <div>
                <label>Difficulty</label>
                <select value={settings.difficulty} onChange={e => setSettings({ ...settings, difficulty: e.target.value })}>
                  <option>Easy</option><option>Medium</option><option>Hard</option>
                </select>
              </div>
              <div>
                <label>Discussion time</label>
                <select value={settings.discussionSeconds} onChange={e => setSettings({ ...settings, discussionSeconds: +e.target.value })}>
                  <option value="60">60 seconds</option>
                  <option value="90">90 seconds</option>
                  <option value="120">120 seconds</option>
                </select>
              </div>
            </div>

            <label className="duel-toggle">
              <input type="checkbox" checked={settings.duelMode}
                onChange={e => setSettings({ ...settings, duelMode: e.target.checked })} />
              <span>⚔️ Duel Mode <small>(2 players only — no voting)</small></span>
            </label>

            <button className="primary" disabled={!nameOk} onClick={create}>
              CREATE A ROOM <span>↗</span>
            </button>
            <div className="or">OR JOIN A ROOM</div>
            <div className="join">
              <input
                value={roomCode}
                onChange={e => setRoomCode(e.target.value.toUpperCase())}
                placeholder="6-CHARACTER CODE"
                maxLength="6"
              />
              <button onClick={join} disabled={!nameOk || roomCode.length < 4}>JOIN</button>
            </div>
            {notice && <p className="notice">{notice}</p>}
          </div>

          <div className="features">
            <span>👥 2–8 PLAYERS</span>
            <span>🎯 3 ROUNDS</span>
            <span>⚡ NO DOWNLOAD</span>
            <span>⚔️ DUEL MODE</span>
          </div>
        </section>

      ) : (
        /* ═══════════════════════════ GAME SCREEN ════════════════════════════ */
        <section className="game">

          {/* Gamebar */}
          <div className="gamebar">
            <div>
              <span className="eyebrow">ROOM CODE</span>
              <strong className="roomcode">{room.code}</strong>
              <button className="copy" onClick={() => navigator.clipboard?.writeText(room.code)}>COPY</button>
            </div>
            <div className="round">
              {room.phase === 'lobby'
                ? isDuel ? '⚔️ DUEL LOBBY' : 'WAITING LOBBY'
                : `ROUND ${Math.min(room.round, 3)} / 3`}
              <small>{isDuel && room.phase !== 'lobby' ? '⚔️ DUEL · ' : ''}{room.phase.toUpperCase()}</small>
            </div>
            <div className="timer">
              {timedPhases.includes(room.phase) ? `${time}s` : '•••'}
            </div>
            <button className="exit-btn" onClick={leaveGame} type="button" title="Leave this room">
              ↩ EXIT GAME
            </button>
          </div>

          <div className="columns">
            {/* ─── Left Column ─────────────────────────────────────────────── */}
            <div className="left">

              {/* Players Panel */}
              <div className="panel">
                <div className="sectionhead">
                  <h2>Players <small>({room.players.length}/8)</small></h2>
                  <span>{active.length} ACTIVE</span>
                </div>
                <div className="playergrid">
                  {room.players.map(p => (
                    <div className={`player ${!p.alive ? 'out' : ''} ${!p.connected ? 'disconnected' : ''}`} key={p.id}>
                      <div className="avatar">{p.avatar}</div>
                      <b>{p.name}{p.host ? ' 👑' : ''}{p.id === socket.id ? ' (you)' : ''}</b>
                      <small>
                        {p.connected
                          ? (p.alive ? 'IN GAME' : 'SPECTATING')
                          : '🔴 DISCONNECTED'}
                      </small>
                      <strong>{p.score} pts</strong>
                      {room.phase === 'lobby' && isHost && p.id !== socket.id && <button className="kick-btn" onClick={() => kickPlayer(p.id)} type="button">REMOVE</button>}
                    </div>
                  ))}
                </div>

                {/* Lobby controls */}
                {room.phase === 'lobby' && (
                  <>
                    <p className="hint">
                      {isDuel
                        ? '⚔️ Duel Mode: exactly 2 players. Roles alternate each round, no voting.'
                        : 'Share the room code. Standard Mode needs at least 3 players.'}
                    </p>
                    {isHost && (
                      <button className="primary"
                        onClick={() => socket.emit('match:start', { code: room.code })}
                        disabled={isDuel ? room.players.length !== 2 : room.players.length < 3}>
                        START GAME <span>↗</span>
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* ── Clue Phase (Standard) ──────────────────────────────────── */}
              {room.phase === 'clues' && (
                <div className="panel">
                  <h2>Clue Round</h2>
                  <p className="hint">Give one short clue. Don't say the secret word!</p>
                  {role === 'innocent'
                    ? <div className="secret"><small>YOUR SECRET WORD</small><strong>{word}</strong><span>{category}</span></div>
                    : <div className="secret impostor"><small>YOUR ROLE</small><strong>IMPOSTOR</strong><span>Blend in. You don't know the word.</span></div>
                  }
                  {turn?.playerId === socket.id
                    ? <div className="clueform">
                        <input value={clue} onChange={e => setClue(e.target.value)} maxLength="100" placeholder="Type your clue…" />
                        <button onClick={sendClue} disabled={!clue.trim()}>SEND</button>
                      </div>
                    : <p className="hint">⏳ {room.players.find(p => p.id === turn?.playerId)?.name || 'A player'} is giving a clue…</p>
                  }
                  <ClueList clues={room.clues} />
                </div>
              )}

              {/* ── Duel Clue Phase ────────────────────────────────────────── */}
              {room.phase === 'duel_clue' && (
                <div className="panel">
                  <div className="duel-badge">⚔️ DUEL MODE</div>
                  <h2>Give Your Clue</h2>
                  {role === 'innocent'
                    ? <>
                        <div className="secret"><small>YOUR SECRET WORD</small><strong>{word}</strong><span>{category}</span></div>
                        <p className="hint">Give ONE clue. The impostor will try to guess your word!</p>
                        {turn?.playerId === socket.id
                          ? <div className="clueform">
                              <input value={clue} onChange={e => setClue(e.target.value)} maxLength="100" placeholder="Your clue…" />
                              <button onClick={sendClue} disabled={!clue.trim()}>SEND CLUE</button>
                            </div>
                          : <p className="hint">Waiting for your turn…</p>
                        }
                      </>
                    : <>
                        <div className="secret impostor"><small>YOUR ROLE</small><strong>IMPOSTOR</strong><span>Listen carefully to the clue!</span></div>
                        <p className="hint">⏳ The innocent is giving a clue…</p>
                      </>
                  }
                  <ClueList clues={room.clues} />
                </div>
              )}

              {/* ── Duel Guess Phase ───────────────────────────────────────── */}
              {room.phase === 'duel_guess' && (
                <div className="panel">
                  <div className="duel-badge">⚔️ DUEL GUESS</div>
                  <h2>Guess the Secret Word</h2>
                  <ClueList clues={room.clues} />
                  {role === 'impostor'
                    ? <>
                        <p className="hint">You have <b>{time}s</b> to guess! Based on the clue above, what is the secret word?</p>
                        <div className="clueform">
                          <input value={duelGuess} onChange={e => setDuelGuess(e.target.value)} placeholder="Guess the secret word…" />
                          <button onClick={submitDuelGuess} disabled={!duelGuess.trim()}>GUESS</button>
                        </div>
                      </>
                    : <p className="hint">⏳ The impostor is guessing… ({time}s left)</p>
                  }
                </div>
              )}

              {/* ── Discussion Phase ───────────────────────────────────────── */}
              {room.phase === 'discussion' && (
                <div className="panel">
                  <h2>Discuss the Clues</h2>
                  <ClueList clues={room.clues} />
                  <div className="chat">
                    <div className="chatlog">
                      {chat.map(m => <p key={m.id}><b>{m.name}:</b> {m.text}</p>)}
                      <div ref={chatEndRef} />
                    </div>
                    {me?.alive && (
                      <div className="clueform">
                        <input
                          value={message}
                          onChange={e => setMessage(e.target.value)}
                          maxLength="250"
                          placeholder="Discuss with your team…"
                          onKeyDown={e => e.key === 'Enter' && sendChat()}
                        />
                        <button onClick={sendChat} disabled={!message.trim()}>SEND</button>
                      </div>
                    )}
                    {isHost && (
                      <button className="primary" style={{marginTop:10}}
                        onClick={() => socket.emit('discussion:vote', { code: room.code })}>
                        START VOTING ↗
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── Voting / Revote ────────────────────────────────────────── */}
              {['voting', 'revote'].includes(room.phase) && (
                <div className="panel">
                  <h2>{room.phase === 'revote' ? '🔁 Revote (Tied!)' : 'Vote for the Impostor'}</h2>
                  <ClueList clues={room.clues} />
                  <p className="hint">Choose who you think is the impostor. Votes are private.</p>
                  {active
                    .filter(p => p.id !== socket.id)
                    .filter(p => room.phase !== 'revote' || room.tiedIds?.includes(p.id))
                    .map(p => (
                      <button className="vote" key={p.id} onClick={() => castVote(p.id)}>
                        {p.avatar} {p.name} <span>VOTE</span>
                      </button>
                    ))}
                  <p className="hint">Votes in: {progress?.count || 0} / {progress?.total || active.length}</p>
                  {isHost && (
                    <button className="secondary" onClick={() => socket.emit('vote:finish', { code: room.code })}>
                      END VOTING EARLY
                    </button>
                  )}
                </div>
              )}

              {/* ── Final Guess (Standard) ─────────────────────────────────── */}
              {room.phase === 'finalguess' && (
                <div className="panel">
                  <h2>⚡ One Last Chance!</h2>
                  <p>The impostor has <b>{time}s</b> to guess the secret word.</p>
                  {role === 'impostor'
                    ? <div className="clueform">
                        <input value={guess} onChange={e => setGuess(e.target.value)} placeholder="Guess the secret word…" />
                        <button onClick={submitFinalGuess} disabled={!guess.trim()}>GUESS</button>
                      </div>
                    : <p className="hint">Waiting for the impostor's final guess…</p>
                  }
                </div>
              )}

              {/* ── Reveal / Finished ──────────────────────────────────────── */}
              {['reveal', 'finished'].includes(room.phase) && (
                <div className="panel reveal">
                  <div className="eyebrow">{room.phase === 'finished' ? 'GAME OVER' : 'ROUND REVEAL'}</div>
                  <h2>{room.winner === 'innocents' ? '🎉 Innocents Win!' : '😈 Impostor Wins!'}</h2>
                  <div className="secret">
                    <small>THE SECRET WORD</small>
                    <strong>{room.secretWord}</strong>
                    <span>{room.category}</span>
                  </div>
                  <p>{room.result}</p>
                  <p><b>Impostor:</b> {room.players.find(p => p.id === room.impostorId)?.name || 'Unknown'}</p>
                  {room.phase === 'finished' && <h3>🏆 Final Leaderboard</h3>}
                  <ol>
                    {[...room.players].sort((a, b) => b.score - a.score).map(p => (
                      <li key={p.id}>{p.avatar} {p.name} — <b>{p.score} pts</b></li>
                    ))}
                  </ol>
                  {isHost && room.phase === 'reveal' && (
                    <button className="primary" onClick={() => socket.emit('round:next', { code: room.code })}>
                      {room.round >= 3 ? 'SHOW FINAL LEADERBOARD' : 'NEXT ROUND'} ↗
                    </button>
                  )}
                  {room.phase === 'finished' && (
                    <button className="secondary" style={{marginTop:12}} onClick={() => window.location.reload()}>
                      PLAY AGAIN
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ─── Right Sidebar ────────────────────────────────────────────── */}
            <aside className="right">
              <div className="panel">
                <h3>HOW TO PLAY</h3>
                {isDuel
                  ? <>
                      <p>⚔️ <b>Duel Mode:</b> 2 players, 3 rounds.</p>
                      <p>🤫 Innocent gets a secret word & gives ONE clue.</p>
                      <p>🎯 Impostor has 30s to guess the word.</p>
                      <p>🔄 Roles alternate every round.</p>
                    </>
                  : <>
                      <p>🤫 Innocents get a secret word. The impostor doesn't.</p>
                      <p>💬 Give clues without saying the word.</p>
                      <p>🗳️ Discuss and vote to find the impostor.</p>
                      <p>🎯 Catch them before they guess the word.</p>
                    </>
                }
              </div>
              <div className="panel">
                <h3>YOUR ROLE</h3>
                {role
                  ? <div className={`role ${role}`}>
                      <b>{role === 'impostor' ? 'IMPOSTOR' : 'INNOCENT'}</b>
                      <span>{role === 'impostor' ? 'Blend in. Guess the word if caught.' : `Secret: ${word || '—'}`}</span>
                    </div>
                  : <p className="hint">Your role appears when the game starts.</p>
                }
              </div>
              <div className="panel">
                <h3>SCORING</h3>
                {isDuel
                  ? <>
                      <p>Impostor guesses correctly <b>+5</b></p>
                      <p>Innocent wins a round <b>+3</b></p>
                    </>
                  : <>
                      <p>Correct innocent vote <b>+2</b></p>
                      <p>Impostor survives tie <b>+3</b></p>
                      <p>Impostor guesses word <b>+5</b></p>
                      <p>Round win bonus <b>+5</b></p>
                    </>
                }
              </div>
            </aside>
          </div>

          {notice && <p className="notice">{notice}</p>}
        </section>
      )}

      <footer>FIND THE IMPOSTOR <span>•</span> A SOCIAL DEDUCTION GAME</footer>
    </main>
  );
}

// ─── Clue List Component ──────────────────────────────────────────────────────
function ClueList({ clues = [] }) {
  if (!clues.length) return null;
  return (
    <div className="cluelist">
      {clues.map((c, i) => <p key={i}><b>{c.name}:</b> {c.text}</p>)}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
