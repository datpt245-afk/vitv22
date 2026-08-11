const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

// Bắt mọi lỗi ngầm để tránh sập Server Node.js
process.on("uncaughtException", (err) => console.error("Lỗi Server:", err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const QUESTIONS_FILE = path.join(__dirname, "questions.json");

// Hàm đọc file an toàn tuyệt đối (Không lo file rỗng hay lỗi JSON)
function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const raw = fs.readFileSync(QUESTIONS_FILE, "utf8").trim();
      if (raw) return JSON.parse(raw);
    }
  } catch (err) {
    console.error("Lỗi đọc file questions.json:", err);
  }
  return [];
}

function saveQuestions(data) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Lỗi ghi file questions.json:", err);
  }
}

let questions = loadQuestions();

let gameState = {
  started: false,
  finished: false,
  currentQuestionIndex: -1,
  activeResponder: null,
  lockedGroups: [],
  scores: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
};

let players = {};

io.on("connection", (socket) => {
  // Gửi toàn bộ trạng thái hiện tại cho người mới vào
  socket.emit("initQuestions", questions);
  socket.emit("updateQuestions", questions);
  socket.emit("state", gameState);
  socket.emit("updateScores", gameState.scores);

  // Quản lý câu hỏi
  const onAddQ = (q) => { if (q) { questions.push(q); saveQuestions(questions); io.emit("updateQuestions", questions); } };
  const onDeleteQ = (i) => { if (i >= 0 && i < questions.length) { questions.splice(i, 1); saveQuestions(questions); io.emit("updateQuestions", questions); } };
  const onImportQ = (list) => { if (Array.isArray(list)) { questions = list; saveQuestions(questions); io.emit("updateQuestions", questions); } };

  socket.on("addQuestion", onAddQ);
  socket.on("mc_addQuestion", onAddQ);
  socket.on("deleteQuestion", onDeleteQ);
  socket.on("mc_deleteQuestion", onDeleteQ);
  socket.on("importQuestions", onImportQ);
  socket.on("mc_importQuestions", onImportQ);

  // Điều khiển Game
  socket.on("startQuestion", (idx) => {
    if (idx >= 0 && idx < questions.length) {
      gameState.started = true;
      gameState.currentQuestionIndex = idx;
      gameState.activeResponder = null;
      gameState.lockedGroups = [];
      io.emit("state", gameState);
      io.emit("questionStarted", questions[idx]);
    }
  });
  socket.on("mc_startQuestion", (idx) => socket.emit("startQuestion", idx));

  socket.on("resetBuzzer", () => { gameState.activeResponder = null; io.emit("state", gameState); });
  socket.on("mc_resetBuzzer", () => { gameState.activeResponder = null; io.emit("state", gameState); });

  socket.on("judgeAnswer", (data) => {
    if (!data) return;
    if (data.isCorrect) {
      gameState.scores[data.group] = (gameState.scores[data.group] || 0) + (data.points || 10);
      gameState.started = false;
      gameState.activeResponder = null;
      io.emit("updateScores", gameState.scores);
    } else {
      if (gameState.activeResponder && !gameState.lockedGroups.includes(gameState.activeResponder.group)) {
        gameState.lockedGroups.push(gameState.activeResponder.group);
      }
      gameState.activeResponder = null;
    }
    io.emit("state", gameState);
  });
  socket.on("mc_judgeAnswer", (data) => socket.emit("judgeAnswer", data));

  // Người chơi
  socket.on("joinPlayer", (pData) => {
    if (!pData || !pData.name) return;
    players[socket.id] = pData;
    socket.emit("joined", pData);
    io.emit("updatePlayerList", Object.values(players));
    socket.emit("state", gameState);
  });

  socket.on("buzz", () => {
    const p = players[socket.id];
    if (p && gameState.started && !gameState.activeResponder && !gameState.lockedGroups.includes(p.group)) {
      gameState.activeResponder = { socketId: socket.id, name: p.name, group: p.group };
      io.emit("buzzWinner", gameState.activeResponder);
      io.emit("state", gameState);
      socket.emit("answerAccess", { question: questions[gameState.currentQuestionIndex], player: p });
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("updatePlayerList", Object.values(players));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
