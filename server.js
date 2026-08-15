const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Cho phép Express phục vụ trực tiếp các file HTML/CSS ở thư mục gốc
app.use(express.static(__dirname));

const questions = [
  {
    q: "Thủ đô của Việt Nam là gì?",
    options: ["Đà Nẵng", "Hà Nội", "TP. Hồ Chí Minh", "Cần Thơ"],
    answer: 1
  },
  {
    q: "Số nào sau đây là số nguyên tố?",
    options: ["4", "6", "7", "9"],
    answer: 2
  }
];

let gameState = {
  started: false,
  currentQuestion: -1,
  answerRevealed: false,
  buzzedTeam: null,
  blockedTeams: [],
  teamStep: 2,         // Điểm nhóm mặc định
  personalPoint: 1,    // Điểm cá nhân mặc định
  teams: {
    "1": { id: "1", name: "Nhóm 1", score: 0, correct: 0, members: {} },
    "2": { id: "2", name: "Nhóm 2", score: 0, correct: 0, members: {} },
    "3": { id: "3", name: "Nhóm 3", score: 0, correct: 0, members: {} },
    "4": { id: "4", name: "Nhóm 4", score: 0, correct: 0, members: {} },
    "5": { id: "5", name: "Nhóm 5", score: 0, correct: 0, members: {} }
  },
  questions: questions
};

let questionTimer = null;

io.on("connection", (socket) => {
  // Gửi trạng thái hiện tại ngay khi client kết nối
  socket.emit("state", gameState);

  // --- 1. LẮNG NGHE LỆNH TỪ MC: LƯU / THÊM / XÓA CÂU HỎI ---
  socket.on("saveQuestions", (newQuestions) => {
    gameState.questions = newQuestions;
    io.emit("state", gameState); // Đồng bộ lại toàn bộ client
  });

  // --- 2. LẮNG NGHE LỆNH TỪ MC: CHUYỂN CÂU HỎI TIẾP THEO ---
  socket.on("nextQuestion", () => {
    const nextIndex = gameState.currentQuestion + 1;
    if (nextIndex < gameState.questions.length) {
      gameState.currentQuestion = nextIndex;
      gameState.started = true; // Tự động bật started để đóng Rules Overlay trên Screen
      gameState.answerRevealed = false;
      gameState.buzzedTeam = null;
      gameState.blockedTeams = [];
      clearTimeout(questionTimer);

      io.emit("questionOpened", {
        index: nextIndex,
        question: gameState.questions[nextIndex]
      });
      io.emit("state", gameState);
    }
  });

  // MC mở câu hỏi theo index cụ thể
  socket.on("openQuestion", (index) => {
    if (index >= 0 && index < gameState.questions.length) {
      gameState.currentQuestion = index;
      gameState.started = true;
      gameState.answerRevealed = false;
      gameState.buzzedTeam = null;
      gameState.blockedTeams = [];
      clearTimeout(questionTimer);

      io.emit("questionOpened", {
        index: index,
        question: gameState.questions[index]
      });
      io.emit("state", gameState);
    }
  });

  // MC Bắt đầu trò chơi
  socket.on("startGame", () => {
    gameState.started = true;
    io.emit("gameStarted");
    io.emit("state", gameState);
  });

  // MC Thiết lập điểm số
  socket.on("setScoring", (data) => {
    if (data.teamStep) gameState.teamStep = data.teamStep;
    if (data.personalPoint) gameState.personalPoint = data.personalPoint;
    io.emit("state", gameState);
  });

  // MC Reset trò chơi
  socket.on("resetGame", () => {
    gameState.currentQuestion = -1;
    gameState.started = false;
    gameState.answerRevealed = false;
    gameState.buzzedTeam = null;
    gameState.blockedTeams = [];
    Object.keys(gameState.teams).forEach(k => {
      gameState.teams[k].score = 0;
      gameState.teams[k].correct = 0;
      gameState.teams[k].members = {};
    });
    io.emit("state", gameState);
  });

  // --- 3. XỬ LÝ BẤM CHUÔNG & TRẢ LỜI ---
  socket.on("buzz", (data) => {
    if (!gameState.buzzedTeam && !gameState.blockedTeams.includes(String(data.group))) {
      gameState.buzzedTeam = data;
      io.emit("buzzed", data);
      io.emit("state", gameState);

      clearTimeout(questionTimer);
      questionTimer = setTimeout(() => {
        if (gameState.buzzedTeam) {
          const failedTeam = gameState.buzzedTeam;
          gameState.blockedTeams.push(String(failedTeam.group));
          gameState.buzzedTeam = null;

          io.emit("wrong", {
            name: failedTeam.name,
            group: failedTeam.group,
            timedOut: true
          });
          io.emit("state", gameState);
        }
      }, 10000);
    }
  });

  socket.on("submitAnswer", (data) => {
    clearTimeout(questionTimer);
    const currentQ = gameState.questions[gameState.currentQuestion];

    if (!currentQ || !gameState.buzzedTeam) return;

    if (data.optionIndex === currentQ.answer) {
      gameState.answerRevealed = true;
      const teamId = String(gameState.buzzedTeam.group);
      
      const step = gameState.teamStep || 10;
      const pPoint = gameState.personalPoint || 1;

      if (gameState.teams[teamId]) {
        gameState.teams[teamId].score += step;
        gameState.teams[teamId].correct += 1;
        
        // Cập nhật điểm cá nhân
        const memberName = gameState.buzzedTeam.name;
        if (memberName) {
          if (!gameState.teams[teamId].members[memberName]) {
            gameState.teams[teamId].members[memberName] = { score: 0, correct: 0 };
          }
          gameState.teams[teamId].members[memberName].score += pPoint;
          gameState.teams[teamId].members[memberName].correct += 1;
        }
      }

      io.emit("result", {
        name: gameState.buzzedTeam.name,
        group: gameState.buzzedTeam.group,
        teamStep: step,
        personalPoint: pPoint
      });
      gameState.buzzedTeam = null;
    } else {
      const failedGroup = String(gameState.buzzedTeam.group);
      gameState.blockedTeams.push(failedGroup);

      io.emit("wrong", {
        name: gameState.buzzedTeam.name,
        group: gameState.buzzedTeam.group,
        timedOut: false
      });
      gameState.buzzedTeam = null;

      const activeGroups = Object.keys(gameState.teams);
      if (gameState.blockedTeams.length >= activeGroups.length) {
        gameState.answerRevealed = true;
        io.emit("questionSkipped");
      }
    }

    io.emit("state", gameState);
  });

  socket.on("resetBuzz", () => {
    gameState.buzzedTeam = null;
    io.emit("resetBuzz");
    io.emit("state", gameState);
  });

  socket.on("finishGame", () => {
    io.emit("gameFinished");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại cổng ${PORT}`);
});
