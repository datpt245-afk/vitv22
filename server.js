const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const QUESTIONS_FILE = path.join(__dirname, "questions.json");

// Đọc câu hỏi từ file JSON
function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const data = fs.readFileSync(QUESTIONS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Lỗi đọc questions.json:", err);
  }
  return [];
}

// Lưu câu hỏi vào file JSON
function saveQuestions(data) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Lỗi ghi questions.json:", err);
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
  // Gửi thông tin ban đầu cho client ngay khi kết nối
  socket.emit("initQuestions", questions);
  socket.emit("updateQuestions", questions);
  socket.emit("state", gameState);
  socket.emit("updateScores", gameState.scores);

  // --- HÀM XỬ LÝ CÂU HỎI (HỖ TRỢ CẢ TÊN SỰ KIỆN CŨ LẪN MỚI) ---
  const handleAddQuestion = (qData) => {
    if (!qData) return;
    questions.push(qData);
    saveQuestions(questions);
    io.emit("updateQuestions", questions);
    io.emit("initQuestions", questions);
  };

  const handleDeleteQuestion = (index) => {
    if (index >= 0 && index < questions.length) {
      questions.splice(index, 1);
      saveQuestions(questions);
      io.emit("updateQuestions", questions);
      io.emit("initQuestions", questions);
    }
  };

  const handleImportQuestions = (list) => {
    if (Array.isArray(list)) {
      questions = list;
      saveQuestions(questions);
      io.emit("updateQuestions", questions);
      io.emit("initQuestions", questions);
    }
  };

  // Bắt cả 2 tên sự kiện (Tránh lệch giao diện MC)
  socket.on("addQuestion", handleAddQuestion);
  socket.on("mc_addQuestion", handleAddQuestion);

  socket.on("deleteQuestion", handleDeleteQuestion);
  socket.on("mc_deleteQuestion", handleDeleteQuestion);

  socket.on("importQuestions", handleImportQuestions);
  socket.on("mc_importQuestions", handleImportQuestions);

  // --- ĐIỀU KHIỂN GAME ---
  const handleStartQuestion = (qIndex) => {
    if (qIndex >= 0 && qIndex < questions.length) {
      gameState.started = true;
      gameState.finished = false;
      gameState.currentQuestionIndex = qIndex;
      gameState.activeResponder = null;
      gameState.lockedGroups = [];
      
      io.emit("state", gameState);
      io.emit("questionStarted", questions[qIndex]);
    }
  };

  socket.on("startQuestion", handleStartQuestion);
  socket.on("mc_startQuestion", handleStartQuestion);

  socket.on("resetBuzzer", () => {
    gameState.activeResponder = null;
    io.emit("state", gameState);
  });
  socket.on("mc_resetBuzzer", () => {
    gameState.activeResponder = null;
    io.emit("state", gameState);
  });

  const handleJudgeAnswer = (data) => {
    if (!data) return;
    if (data.isCorrect) {
      gameState.scores[data.group] = (gameState.scores[data.group] || 0) + (data.points || 10);
      gameState.started = false;
      gameState.activeResponder = null;
      io.emit("updateScores", gameState.scores);
      io.emit("answerResult", { isCorrect: true, winnerGroup: data.group });
    } else {
      if (gameState.activeResponder && !gameState.lockedGroups.includes(gameState.activeResponder.group)) {
        gameState.lockedGroups.push(gameState.activeResponder.group);
      }
      gameState.activeResponder = null;
      io.emit("answerResult", { isCorrect: false, lockedGroup: data.group });
    }
    io.emit("state", gameState);
  };

  socket.on("judgeAnswer", handleJudgeAnswer);
  socket.on("mc_judgeAnswer", handleJudgeAnswer);

  socket.on("updateScore", ({ group, score }) => {
    gameState.scores[group] = Number(score) || 0;
    io.emit("updateScores", gameState.scores);
  });
  socket.on("mc_updateScore", ({ group, score }) => {
    gameState.scores[group] = Number(score) || 0;
    io.emit("updateScores", gameState.scores);
  });

  const handleResetGame = () => {
    gameState = {
      started: false,
      finished: false,
      currentQuestionIndex: -1,
      activeResponder: null,
      lockedGroups: [],
      scores: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    };
    players = {};
    io.emit("state", gameState);
    io.emit("updateScores", gameState.scores);
    io.emit("gameReset");
  };

  socket.on("resetGame", handleResetGame);
  socket.on("mc_resetGame", handleResetGame);

  // --- NGƯỜI CHƠI ---
  socket.on("joinPlayer", (pData) => {
    if (!pData || !pData.name) return;
    players[socket.id] = pData;
    socket.emit("joined", pData);
    io.emit("updatePlayerList", Object.values(players));
    socket.emit("state", gameState);
  });

  socket.on("buzz", () => {
    const p = players[socket.id];
    if (!p) return;

    if (gameState.started && !gameState.activeResponder && !gameState.lockedGroups.includes(p.group)) {
      gameState.activeResponder = {
        socketId: socket.id,
        name: p.name,
        group: p.group
      };

      io.emit("buzzWinner", gameState.activeResponder);
      io.emit("state", gameState);

      const currentQ = questions[gameState.currentQuestionIndex];
      socket.emit("answerAccess", { question: currentQ, player: p });
    }
  });

  socket.on("disconnect", () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit("updatePlayerList", Object.values(players));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server dang chay tai port ${PORT}`);
});
