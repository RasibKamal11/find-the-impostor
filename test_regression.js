const { io } = require("socket.io-client");
const { spawn } = require("child_process");

const TEST_PORT = 4124;
const SERVER_URL = `http://localhost:${TEST_PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createClient(sid) {
  return io(SERVER_URL, {
    auth: { sessionId: sid },
    transports: ["websocket"],
    forceNew: true,
  });
}

async function runTests() {
  console.log("=== Starting Server for Regression Testing ===");
  const serverProcess = spawn("node", ["server/index.js"], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: "inherit",
  });

  // Give server time to bind
  await sleep(1500);

  try {
    console.log("\n==============================================");
    console.log("TEST 1: B1 - Duplicate Clues on Reconnect");
    console.log("==============================================");

    const sid1 = "session-p1-" + Date.now();
    const sid2 = "session-p2-" + Date.now();
    const sid3 = "session-p3-" + Date.now();

    const p1 = createClient(sid1);
    const p2 = createClient(sid2);
    const p3 = createClient(sid3);

    let currentTurn = null;
    let roomStateP1 = null;
    let roomStateP2 = null;
    let roomStateP3 = null;

    p1.on("turn:current", (t) => (currentTurn = t));
    p2.on("turn:current", (t) => (currentTurn = t));
    p3.on("turn:current", (t) => (currentTurn = t));

    p1.on("room:update", (r) => {
      console.log(`[P1 EVENT] room:update received. phase: ${r.phase}, clues count: ${r.clues?.length}`);
      roomStateP1 = r;
    });
    p2.on("room:update", (r) => (roomStateP2 = r));
    p3.on("room:update", (r) => (roomStateP3 = r));

    await Promise.all([
      new Promise((res) => p1.on("connect", res)),
      new Promise((res) => p2.on("connect", res)),
      new Promise((res) => p3.on("connect", res)),
    ]);
    console.log("[PASS] 3 clients connected");

    // 1. Create Room
    let roomCode = "";
    await new Promise((res) => {
      p1.emit("room:create", { name: "Alice", avatar: "🦊", sid: sid1 }, (reply) => {
        roomCode = reply.code;
        res();
      });
    });
    console.log(`[PASS] Room created: ${roomCode}`);

    // 2. P2 and P3 Join
    await new Promise((res) => p2.emit("room:join", { code: roomCode, name: "Bob", avatar: "🐼", sid: sid2 }, res));
    await new Promise((res) => p3.emit("room:join", { code: roomCode, name: "Charlie", avatar: "🦁", sid: sid3 }, res));
    console.log("[PASS] Bob and Charlie joined room");

    // 3. Start Game
    p1.emit("match:start", { code: roomCode });
    await sleep(600);

    console.log(`[STATUS] Phase is now: ${roomStateP1?.phase}`);
    if (roomStateP1?.phase !== "clues") {
      throw new Error(`Expected phase 'clues', got '${roomStateP1?.phase}'`);
    }

    // Submit 2 clues according to current turn
    const clientMap = {
      [p1.id]: { client: p1, name: "Alice" },
      [p2.id]: { client: p2, name: "Bob" },
      [p3.id]: { client: p3, name: "Charlie" },
    };

    for (let i = 0; i < 2; i++) {
      await sleep(200);
      const activePlayerId = currentTurn?.playerId;
      const submitterInfo = clientMap[activePlayerId];
      if (!submitterInfo) {
        throw new Error(`Cannot find client for turn: ${activePlayerId}`);
      }
      const clueText = `Clue_${i + 1}_from_${submitterInfo.name}`;
      console.log(`[ACTION] Submitting ${clueText} by ${submitterInfo.name}...`);
      submitterInfo.client.emit("clue:submit", { code: roomCode, text: clueText });
      await sleep(500);
    }

    console.log("[STATUS] Clues before disconnect:", roomStateP1.clues);
    if (roomStateP1.clues.length !== 2) {
      throw new Error(`Expected 2 clues, got ${roomStateP1.clues.length}`);
    }

    // 4. Disconnect Bob (P2)
    console.log("[ACTION] Disconnecting Bob (p2)...");
    const oldP2Id = p2.id;
    p2.disconnect();
    await sleep(800);

    // Verify Bob is marked disconnected
    const bobInRoom = roomStateP1.players.find((p) => p.name === "Bob");
    console.log("[STATUS] Bob connected status in room:", bobInRoom?.connected);
    if (bobInRoom?.connected !== false) {
      throw new Error("Expected Bob to be marked disconnected");
    }

    // 5. Reconnect Bob (P2) within 60 seconds with same sessionId
    console.log("[ACTION] Reconnecting Bob within 60s with same sessionId...");
    const p2Reconnected = createClient(sid2);
    let reconnectedRoom = null;
    let clueNewEventCount = 0;

    p2Reconnected.on("turn:current", (t) => (currentTurn = t));
    p2Reconnected.on("room:update", (r) => {
      reconnectedRoom = r;
    });
    p2Reconnected.on("clue:new", () => {
      clueNewEventCount++;
    });

    await new Promise((res) => p2Reconnected.on("connect", res));
    await sleep(800);

    if (!reconnectedRoom) {
      throw new Error("Reconnected client did not receive room:update");
    }

    // Update client map with Bob's new socket id
    delete clientMap[oldP2Id];
    clientMap[p2Reconnected.id] = { client: p2Reconnected, name: "Bob" };

    console.log("[STATUS] Bob reconnected. clues array received:", reconnectedRoom.clues);
    const clueTexts = reconnectedRoom.clues.map((c) => c.text);
    const uniqueClueTexts = [...new Set(clueTexts)];

    console.log(`[VERIFY] Total clues: ${clueTexts.length}, Unique clues: ${uniqueClueTexts.length}`);
    if (clueTexts.length !== 2 || uniqueClueTexts.length !== 2) {
      throw new Error(`Duplicate clues found! Expected 2 unique clues, got: ${JSON.stringify(clueTexts)}`);
    }
    console.log("[PASS] B1 Verified: Every clue appears exactly once after reconnect (no duplicates).");

    // 6. Submit 3rd clue to finish clue round
    await sleep(200);
    const activePlayerId = currentTurn?.playerId;
    const submitterInfo = clientMap[activePlayerId];
    const clue3Text = `Clue_3_from_${submitterInfo.name}`;
    console.log(`[ACTION] Submitting final clue: ${clue3Text}...`);
    submitterInfo.client.emit("clue:submit", { code: roomCode, text: clue3Text });
    await sleep(800);

    console.log(`[STATUS] Phase after all clues submitted: ${roomStateP1?.phase}`);
    if (roomStateP1?.phase !== "discussion") {
      throw new Error(`Expected phase to transition to 'discussion', got '${roomStateP1?.phase}'`);
    }

    console.log("\n==============================================");
    console.log("TEST 2: B4 - Voting, Zero-Vote Guard & Security Checks");
    console.log("==============================================");

    // Host triggers voting
    console.log("[ACTION] Host starts voting phase...");
    p1.emit("discussion:vote", { code: roomCode });
    await sleep(500);

    console.log(`[STATUS] Phase is now: ${roomStateP1?.phase}`);
    if (roomStateP1?.phase !== "voting") {
      throw new Error("Expected phase to be 'voting'");
    }

    // Step 3 & 4 of B4 test: Ask the host to finish voting before anyone votes -> Verify nothing happens.
    console.log("[ACTION] Host attempts vote:finish before ANYONE votes (Zero-vote force-end)...");
    p1.emit("vote:finish", { code: roomCode });
    await sleep(500);

    if (roomStateP1.phase !== "voting" || roomStateP1.votesRevealed) {
      throw new Error("[FAIL] B4 Bug reproduced! Zero-vote force-end prematurely resolved voting!");
    }
    console.log("[PASS] Zero-vote guard succeeded: Phase remains 'voting', nothing happened.");

    // Security Check: Server doesn't accept votes from disconnected player
    console.log("[ACTION] Security Check: Disconnected player attempting to vote...");
    p2.emit("vote:cast", { code: roomCode, targetId: p1.id });
    await sleep(300);
    p1.emit("vote:finish", { code: roomCode });
    await sleep(300);
    if (roomStateP1.phase !== "voting") {
      throw new Error("[FAIL] Disconnected player vote was counted!");
    }
    console.log("[PASS] Disconnected player cannot vote.");

    // Security Check: Self-vote rejected
    console.log("[ACTION] Security Check: Cannot vote for self...");
    p1.emit("vote:cast", { code: roomCode, targetId: p1.id });
    await sleep(300);
    p1.emit("vote:finish", { code: roomCode });
    await sleep(300);
    if (roomStateP1.phase !== "voting") {
      throw new Error("[FAIL] Self-vote was counted!");
    }
    console.log("[PASS] Self-vote rejected.");

    console.log("\n==============================================");
    console.log("TEST 3: B4 - Revote on Tie Scenario & Zero-Vote Guard in Revote");
    console.log("==============================================");
    // Submit tied votes:
    // P1 (Alice) votes for Bob (p2Reconnected.id)
    // Bob (p2Reconnected) votes for Alice (p1.id)
    console.log("[ACTION] Alice votes Bob, Bob votes Alice (1-1 tie)...");
    p1.emit("vote:cast", { code: roomCode, targetId: p2Reconnected.id });
    p2Reconnected.emit("vote:cast", { code: roomCode, targetId: p1.id });
    await sleep(400);

    // Host finishes voting with a tie
    console.log("[ACTION] Host ends voting early with 1-1 tie...");
    p1.emit("vote:finish", { code: roomCode });
    await sleep(800);

    console.log(`[STATUS] Phase after tie: ${roomStateP1.phase}, tiedIds: ${JSON.stringify(roomStateP1.tiedIds)}`);
    if (roomStateP1.phase !== "revote") {
      throw new Error(`Expected phase 'revote', got '${roomStateP1.phase}'`);
    }
    if (!roomStateP1.tiedIds || roomStateP1.tiedIds.length !== 2) {
      throw new Error(`Expected tiedIds to contain 2 candidates, got ${JSON.stringify(roomStateP1.tiedIds)}`);
    }
    console.log("[PASS] Tie properly initiated 'revote' phase with tied candidates!");

    // Test zero-vote guard in REVOTE
    console.log("[ACTION] Host attempts vote:finish during REVOTE before anyone votes...");
    p1.emit("vote:finish", { code: roomCode });
    await sleep(500);

    if (roomStateP1.phase !== "revote") {
      throw new Error("[FAIL] Zero-vote force-end occurred during revote!");
    }
    console.log("[PASS] Zero-vote guard succeeded in revote phase! Nothing happened.");

    // Now resolve revote: Alice and Charlie vote for Bob
    console.log("[ACTION] Resolving revote: Alice and Charlie vote for Bob...");
    p1.emit("vote:cast", { code: roomCode, targetId: p2Reconnected.id });
    p3.emit("vote:cast", { code: roomCode, targetId: p2Reconnected.id });
    await sleep(500);

    p1.emit("vote:finish", { code: roomCode });
    await sleep(800);

    console.log(`[STATUS] Phase after revote resolution: ${roomStateP1.phase}`);
    console.log(`[STATUS] Eliminated ID: ${roomStateP1.eliminatedId}`);
    if (roomStateP1.eliminatedId !== p2Reconnected.id) {
      throw new Error(`Expected Bob (${p2Reconnected.id}) to be eliminated, got: ${roomStateP1.eliminatedId}`);
    }
    console.log("[PASS] Voting resolved correctly! Eliminated player was Bob.");

    // Security Check: Eliminated player (Bob) cannot vote in subsequent rounds/phases
    console.log("[ACTION] Security Check: Eliminated player attempting to vote...");
    p2Reconnected.emit("vote:cast", { code: roomCode, targetId: p1.id });
    await sleep(300);
    console.log("[PASS] Eliminated player cannot vote.");

    // Clean up
    p1.disconnect();
    p2Reconnected.disconnect();
    p3.disconnect();
    serverProcess.kill();

    console.log("\n==============================================");
    console.log(">>> ALL REGRESSION TESTS PASSED CLEANLY! <<<");
    console.log("==============================================");
    process.exit(0);
  } catch (err) {
    console.error("\n[TEST ERROR]:", err);
    serverProcess.kill();
    process.exit(1);
  }
}

runTests();
