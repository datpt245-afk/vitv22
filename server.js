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

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

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
  activeResponder: null,
  lockedGroups: [],
  scoring: {
    teamStep: 2,
    personalPoint: 1
  },
  answerRevealed: false
};

let autoNextTimer = null; // Bộ đếm tự động chuyển câu
let answerTimeout = null;  // 🔴 THÊM: Bộ đếm 5 giây cho người vừa bấm chuông

function loadQuestions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      game.questions = JSON.parse(raw);
      console.log(`[DATA] Đã tải ${game.questions.length} câu hỏi.`);
    }
  } catch (err) {
    game.questions = [];
  }
}

function saveQuestionsToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(game.questions, null, 2), "utf8");
  } catch (err) {}
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

// Hàm kích hoạt chuyển câu tiếp theo
function triggerNextQuestion() {
  if (autoNextTimer) clearTimeout(autoNextTimer);
  if (answerTimeout) clearTimeout(answerTimeout); // 🔴 Hủy timer trả lời nếu có

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
    game.questionOpen = false;
    io.emit("gameFinished");
    io.emit("state", snapshot());
  }
}

// Hàm đếm ngược 5s để tự chuyển câu
function scheduleNextQuestion(delayMs = 5000) {
  if (autoNextTimer) clearTimeout(autoNextTimer);
  autoNextTimer = setTimeout(() => {
    triggerNextQuestion();
  }, delayMs);
}

// 🔴 THÊM: Hàm xử lý khi người chơi bị quá 5s không trả lời (tính là Sai)
function handleTimeout(name, group) {
  const g = String(group);
  game.lockedGroups.push(g);
  game.activeResponder = null;

  io.emit("wrong", {
    name,
    group: g,
    timedOut: true
  });

  // Nếu cả 5 nhóm đều bị khóa -> Tự động hiện đáp án và chuyển câu sau 5s
  if (game.lockedGroups.length >= 5) {
    game.questionOpen = false;
    game.answerRevealed = true;
    io.emit("questionSkipped");
    scheduleNextQuestion(5000);
  }

  io.emit("state", snapshot());
}

io.on("connection", socket => {
  socket.emit("state", snapshot());

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

  socket.on("nextQuestion", () => {
    triggerNextQuestion();
  });

  socket.on("buzz", ({ group, name }) => {
    const g = String(group);
    if (!game.questionOpen || game.activeResponder || game.lockedGroups.includes(g)) return;

    game.activeResponder = { group: g, name: name };
    io.emit("buzzed", { group: g, name: name });
    
    socket.emit("answerAccess", {
      group: g,
      name: name,
      question: game.questions[game.currentQuestion]
    });

    io.emit("state", snapshot());

    // 🔴 BẮT ĐẦU ĐẾM NGƯỢC 5 GIÂY: Nếu quá 5s chưa gửi submitAnswer thì bị phạt Sai
    if (answerTimeout) clearTimeout(answerTimeout);
    answerTimeout = setTimeout(() => {
      if (game.activeResponder && game.activeResponder.group === g) {
        handleTimeout(name, g);
      }
    }, 5000);
  });

  socket.on("submitAnswer", ({ index, name, group }) => {
    const g = String(group);
    if (!game.activeResponder || game.activeResponder.group !== g) return;

    // 🔴 HỦY TIMER 5 GIÂY khi người chơi đã bấm chọn đáp án kịp thời
    if (answerTimeout) clearTimeout(answerTimeout);

    const currentQ = game.questions[game.currentQuestion];
    const isCorrect = currentQ && index === currentQ.answer;

    if (isCorrect) {
      // Trả lời ĐÚNG -> Hiện đáp án + Cộng điểm
      game.questionOpen = false;
      game.answerRevealed = true;

      game.teams[g].score += game.scoring.teamStep;
      game.teams[g].correct += 1;

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

      // TỰ ĐỘNG CHUYỂN CÂU HỎI SAU 5 GIÂY
      scheduleNextQuestion(5000);

    } else {
      // Trả lời SAI
      game.lockedGroups.push(g);
      game.activeResponder = null;

      io.emit("wrong", {
        name,
        group: g,
        timedOut: index === null
      });

      // Nếu cả 5 nhóm đều sai -> Tự động hiện đáp án và chuyển câu sau 5 giây
      if (game.lockedGroups.length >= 5) {
        game.questionOpen = false;
        game.answerRevealed = true;
        io.emit("questionSkipped");
        scheduleNextQuestion(5000);
      }

      io.emit("state", snapshot());
    }
  });

  socket.on("resetBuzz", () => {
    if (answerTimeout) clearTimeout(answerTimeout);
    game.activeResponder = null;
    io.emit("resetBuzz");
    io.emit("state", snapshot());
  });

  socket.on("setScoring", ({ teamStep, personalPoint }) => {
    game.scoring.teamStep = Math.max(1, Number(teamStep) || 2);
    game.scoring.personalPoint = Math.max(1, Number(personalPoint) || 1);
    io.emit("state", snapshot());
  });

  socket.on("resetGame", () => {
    if (autoNextTimer) clearTimeout(autoNextTimer);
    if (answerTimeout) clearTimeout(answerTimeout);
    
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
  console.log(`🚀 Server đang chạy tại port ${PORT}`);
});
