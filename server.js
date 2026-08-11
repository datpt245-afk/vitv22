const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "questions.json");

// Phục vụ các file tĩnh (html, css, js) trong thư mục public hoặc gốc
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// Khởi tạo trạng thái trò chơi
let game = {
  teams: {
    1: { name: "Nhóm 1", score: 0, correct: 0, members: {} },
    2: { name: "Nhóm 2", score: 0, correct: 0, members: {} },
    3: { name: "Nhóm 3", score: 0, correct: 0, members: {} },
    4: { name: "Nhóm 4", score: 0, correct: 0, members: {} },
    5: { name: "Nhóm 5", score: 0, correct: 0, members: {} }
  },
  questions: [],
  currentQuestion: -1,
  questionOpen: false,
  activeResponder: null, // { group, name }
  lockedGroups: [], // Danh sách nhóm đã trả lời sai ở câu hiện tại
  scoring: {
    teamStep: 2,
    personalPoint: 1
  },
  answerRevealed: false
};

// Đọc ngân hàng câu hỏi từ file nếu có
function loadQuestions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      game.questions = JSON.parse(raw);
      console.log(`[DATA] Đã tải ${game.questions.length} câu hỏi từ file.`);
    }
  } catch (err) {
    console.error("[ERROR] Lỗi khi đọc câu hỏi từ file:", err.message);
    game.questions = [];
  }
}

// Lưu ngân hàng câu hỏi vào file
function saveQuestionsToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(game.questions, null, 2), "utf8");
    console.log("[DATA] Đã lưu danh sách câu hỏi vào file.");
  } catch (err) {
    console.error("[ERROR] Lỗi khi lưu file câu hỏi:", err.message);
  }
}

loadQuestions();

function snapshot() {
  return {
    teams: game.teams,
    questions: game.questions,
    currentQuestion: game.currentQuestion,
    questionOpen: game.questionOpen,
    activeResponder: game.activeResponder,
    lockedGroups: game.lockedGroups,
    scoring: game.scoring,
    answerRevealed: game.answerRevealed
  };
}

io.on("connection", socket => {
  // Gửi trạng thái hiện tại ngay khi kết nối
  socket.emit("state", snapshot());

  // Người chơi tham gia nhóm
  socket.on("joinMember", ({ group, name }) => {
    const g = String(group);
    const mName = String(name || "").trim();
    if (game.teams[g] && mName) {
      if (!game.teams[g].members[mName]) {
        game.teams[g].members[mName] = { score: 0, correct: 0 };
      }
      socket.emit("joined", { group: g, name: mName });
      io.emit("state", snapshot());
    }
  });

  // Lưu danh sách câu hỏi từ MC
  socket.on("saveQuestions", questions => {
    if (!Array.isArray(questions)) return;
    game.questions = questions
      .map(q => ({
        q: String(q.q || "").trim(),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(x => String(x).trim()) : [],
        answer: Math.max(0, Math.min(3, Number(q.answer) || 0))
      }))
      .filter(q => q.q && q.options.length === 4 && q.options.every(Boolean));

    saveQuestionsToFile();
    io.emit("questionsSaved", game.questions);
    io.emit("state", snapshot());
  });

  // MC chuyển sang câu hỏi tiếp theo
  socket.on("nextQuestion", () => {
    if (game.currentQuestion + 1 < game.questions.length) {
      game.currentQuestion++;
      game.questionOpen = true;
      game.activeResponder = null;
      game.lockedGroups = [];
      game.answerRevealed = false;

      io.emit("questionOpened", {
        index: game.currentQuestion,
        question: game.questions[game.currentQuestion]
      });
      io.emit("state", snapshot());
    } else {
      io.emit("gameFinished");
    }
  });

  // Người chơi bấm chuông
  socket.on("buzz", ({ group, name }) => {
    const g = String(group);
    if (!game.questionOpen || game.activeResponder || game.lockedGroups.includes(g)) return;

    game.activeResponder = { group: g, name: name };
    io.emit("buzzed", { group: g, name: name });
    
    // Gửi quyền truy cập màn hình trả lời cho đúng người bấm
    socket.emit("answerAccess", {
      group: g,
      name: name,
      question: game.questions[game.currentQuestion]
    });

    io.emit("state", snapshot());
  });

  // Người chơi nộp đáp án
  socket.on("submitAnswer", ({ index, name, group }) => {
    const g = String(group);
    if (!game.activeResponder || game.activeResponder.group !== g) return;

    const currentQ = game.questions[game.currentQuestion];
    const isCorrect = currentQ && index === currentQ.answer;

    if (isCorrect) {
      // Trả lời ĐÚNG
      game.questionOpen = false;
      game.answerRevealed = true;

      // Cộng điểm Nhóm
      game.teams[g].score += game.scoring.teamStep;
      game.teams[g].correct += 1;

      // Cộng điểm Cá nhân
      if (game.teams[g].members[name]) {
        game.teams[g].members[name].score += game.scoring.personalPoint;
        game.teams[g].members[name].correct += 1;
      }

      io.emit("result", {
        correct: true,
        name,
        group: g,
        teamStep: game.scoring.teamStep,
        personalPoint: game.scoring.personalPoint
      });
      
      game.activeResponder = null;
      io.emit("state", snapshot());
    } else {
      // Trả lời SAI hoặc HẾT GIỜ (index === null)
      game.lockedGroups.push(g);
      game.activeResponder = null;

      io.emit("wrong", {
        name,
        group: g,
        timedOut: index === null
      });

      // Nếu cả 5 nhóm đều sai -> Tự động bỏ qua câu hỏi
      if (game.lockedGroups.length >= 5) {
        game.questionOpen = false;
        game.answerRevealed = true;
        io.emit("questionSkipped");
      }

      io.emit("state", snapshot());
    }
  });

  // MC reset chuông cho câu hiện tại
  socket.on("resetBuzz", () => {
    game.activeResponder = null;
    io.emit("resetBuzz");
    io.emit("state", snapshot());
  });

  // MC cập nhật cấu hình điểm
  socket.on("setScoring", ({ teamStep, personalPoint }) => {
    game.scoring.teamStep = Math.max(1, Number(teamStep) || 2);
    game.scoring.personalPoint = Math.max(1, Number(personalPoint) || 1);
    io.emit("state", snapshot());
  });

  // MC reset toàn bộ trò chơi
  socket.on("resetGame", () => {
    Object.keys(game.teams).forEach(g => {
      game.teams[g] = { name: `Nhóm ${g}`, score: 0, correct: 0, members: {} };
    });
    game.currentQuestion = -1;
    game.questionOpen = false;
    game.activeResponder = null;
    game.lockedGroups = [];
    game.answerRevealed = false;

    io.emit("fullReset");
    io.emit("state", snapshot());
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại đường dẫn port ${PORT}`);
});
