const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, "questions.json");

// Tải danh sách câu hỏi lưu trên đĩa cứng (nếu có)
let savedQuestions = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (raw) savedQuestions = JSON.parse(raw);
  }
} catch (e) {
  console.log("Chưa có file câu hỏi cũ hoặc lỗi đọc file:", e.message);
}

app.use(express.static(__dirname));

// Khởi tạo trạng thái ban đầu của 5 nhóm
const teams = {};
for (let i = 1; i <= 5; i++) {
  teams[i] = { id: i, name: `Nhóm ${i}`, score: 0, correct: 0, members: {} };
}

let game = {
  teams,
  questions: savedQuestions,
  currentQuestion: -1,
  questionOpen: false,
  lockedGroups: [], // Danh sách các nhóm bị khóa ở câu hiện tại
  activeResponder: null, // Người duy nhất đang trong màn hình trả lời 10s
  timerEndsAt: null,
  teamStep: 2,
  personalPoint: 1,
  history: [],
  answerRevealed: false
};

let serverTimer = null;

function saveQuestionsToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(game.questions, null, 2), "utf8");
  } catch (e) {
    console.error("Lỗi ghi file câu hỏi:", e);
  }
}

function snapshot() {
  return JSON.parse(JSON.stringify(game));
}

function clearServerTimer() {
  if (serverTimer) {
    clearTimeout(serverTimer);
    serverTimer = null;
  }
}

function processNextQuestion() {
  clearServerTimer();
  game.activeResponder = null;
  game.timerEndsAt = null;
  game.lockedGroups = [];
  game.answerRevealed = false;
  
  game.currentQuestion++;
  if (game.currentQuestion >= game.questions.length) {
    game.questionOpen = false;
    io.emit("gameFinished");
    return io.emit("state", snapshot());
  }

  game.questionOpen = true;
  io.emit("questionOpened", {
    index: game.currentQuestion,
    question: game.questions[game.currentQuestion]
  });
  io.emit("state", snapshot());
}

function processAnswer(socketId, group, name, selectedIdx, timedOut = false) {
  if (!game.activeResponder) return;
  clearServerTimer();

  group = String(group);
  name = String(name || "");
  let q = game.questions[game.currentQuestion];
  let isCorrect = !timedOut && selectedIdx !== null && selectedIdx !== undefined && Number(selectedIdx) === Number(q.answer);

  if (isCorrect) {
    // Trả lời ĐÚNG -> Cộng điểm, bật sáng đáp án đúng và chuyển câu sau 2 giây
    let t = game.teams[group];
    if (t) {
      if (!t.members[name]) t.members[name] = { score: 0, correct: 0 };
      t.score += game.teamStep;
      t.correct += 1;
      t.members[name].score += game.personalPoint;
      t.members[name].correct += 1;
    }

    game.history.push({ type: "correct", group, name, q: game.currentQuestion, time: Date.now() });
    game.questionOpen = false;
    game.activeResponder = null;
    game.timerEndsAt = null;
    game.answerRevealed = true;

    io.emit("result", {
      ok: true,
      group,
      name,
      teamStep: game.teamStep,
      personalPoint: game.personalPoint
    });
    io.emit("state", snapshot());

    setTimeout(() => {
      processNextQuestion();
    }, 2000);
  } else {
    // Trả lời SAI hoặc HẾT 10S -> Khóa toàn bộ nhóm đó ở câu này
    if (!game.lockedGroups.includes(group)) {
      game.lockedGroups.push(group);
    }
    
    game.history.push({ type: "wrong", group, name, q: game.currentQuestion, timedOut, time: Date.now() });
    game.activeResponder = null;
    game.timerEndsAt = null;

    io.emit("wrong", { group, name, timedOut });

    // Nếu CẢ 5 NHÓM ĐỀU SAI -> Tự động chuyển sang câu tiếp theo
    if (game.lockedGroups.length >= 5) {
      game.questionOpen = false;
      io.emit("questionSkipped", { index: game.currentQuestion });
      io.emit("state", snapshot());
      setTimeout(() => {
        processNextQuestion();
      }, 1800);
    } else {
      // Mở lại chuông cho các nhóm còn lại cướp quyền
      io.emit("resetBuzz");
      io.emit("state", snapshot());
    }
  }
}

io.on("connection", socket => {
  socket.emit("state", snapshot());

  socket.on("joinMember", ({ group, name }) => {
    group = String(group);
    name = String(name || "").trim().slice(0, 40);
    if (!game.teams[group] || !name) return;

    if (!game.teams[group].members[name]) {
      game.teams[group].members[name] = { score: 0, correct: 0 };
    }
    socket.data.group = group;
    socket.data.name = name;
    socket.emit("joined", { group, name });
    io.emit("state", snapshot());
  });

  socket.on("buzz", ({ group, name }) => {
    group = String(group);
    name = String(name || "");

    // Kiểm tra câu hỏi có mở, chưa có ai trả lời và nhóm chưa bị khóa
    if (!game.questionOpen || game.activeResponder || game.lockedGroups.includes(group) || !game.teams[group]) {
      return;
    }

    if (!game.teams[group].members[name]) {
      game.teams[group].members[name] = { score: 0, correct: 0 };
    }

    game.activeResponder = { socketId: socket.id, group, name };
    game.timerEndsAt = Date.now() + 10000;

    let q = game.questions[game.currentQuestion];

    // Cấp quyền trả lời riêng cho máy bấm nhanh nhất
    socket.emit("answerAccess", {
      question: { q: q.q, options: q.options },
      endsAt: game.timerEndsAt,
      group,
      name
    });

    io.emit("buzzed", { group, name });
    io.emit("state", snapshot());

    // Đếm ngược 10 giây trên Server
    serverTimer = setTimeout(() => {
      processAnswer(socket.id, group, name, null, true);
    }, 10000);
  });

  socket.on("submitAnswer", ({ group, name, index }) => {
    processAnswer(socket.id, group, name, index, false);
  });

  socket.on("openQuestion", ({ index }) => {
    index = Number(index);
    if (index < 0 || index >= game.questions.length) return;
    game.currentQuestion = index - 1;
    processNextQuestion();
  });

  socket.on("nextQuestion", () => {
    processNextQuestion();
  });

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

  socket.on("setScoring", ({ teamStep, personalPoint }) => {
    game.teamStep = Math.max(1, Number(teamStep) || 2);
    game.personalPoint = Math.max(1, Number(personalPoint) || 1);
    io.emit("state", snapshot());
  });

  socket.on("resetBuzz", () => {
    if (game.questionOpen) {
      clearServerTimer();
      game.activeResponder = null;
      game.timerEndsAt = null;
      io.emit("resetBuzz");
      io.emit("state", snapshot());
    }
  });

  socket.on("resetGame", () => {
    clearServerTimer();
    for (let i = 1; i <= 5; i++) {
      game.teams[i].score = 0;
      game.teams[i].correct = 0;
      game.teams[i].members = {};
    }
    game.currentQuestion = -1;
    game.questionOpen = false;
    game.lockedGroups = [];
    game.activeResponder = null;
    game.timerEndsAt = null;
    game.history = [];
    game.answerRevealed = false;

    io.emit("fullReset");
    io.emit("state", snapshot());
  });
});

server.listen(PORT, () => console.log(`DUCK RACE đang chạy tại port ${PORT}`));
