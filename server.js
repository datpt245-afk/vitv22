const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Phục vụ tĩnh thư mục public
app.use(express.static(path.join(__dirname, "public")));

// Dữ liệu câu hỏi
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

// Trạng thái trò chơi
let gameState = {
  started: false,
  currentQuestion: -1,
  answerRevealed: false,
  buzzedTeam: null,
  blockedTeams: [],
  teams: {
    "1": { id: "1", name: "Nhóm 1", score: 0 },
    "3": { id: "3", name: "Nhóm 3", score: 0 },
    "4": { id: "4", name: "Nhóm 4", score: 0 },
    "5": { id: "5", name: "Nhóm 5", score: 0 }
  },
  questions: questions
};

let questionTimer = null;

io.on("connection", (socket) => {
  try {
    socket.emit("state", gameState);
  } catch (err) {
    console.error("Lỗi khi kết nối:", err);
  }

  socket.on("startGame", () => {
    gameState.started = true;
    io.emit("gameStarted");
    io.emit("state", gameState);
  });

  socket.on("openQuestion", (index) => {
    try {
      if (index >= 0 && index < gameState.questions.length) {
        gameState.currentQuestion = index;
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
    } catch (err) {
      console.error("Lỗi mở câu hỏi:", err);
    }
  });

  socket.on("buzz", (data) => {
    try {
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
    } catch (err) {
      console.error("Lỗi bấm chuông:", err);
    }
  });

  socket.on("submitAnswer", (data) => {
    try {
      clearTimeout(questionTimer);
      const currentQ = gameState.questions[gameState.currentQuestion];

      if (!currentQ || !gameState.buzzedTeam) return;

      if (data.optionIndex === currentQ.answer) {
        // ĐÚNG -> Hiện đáp án
        gameState.answerRevealed = true;
        const teamId = String(gameState.buzzedTeam.group);
        if (gameState.teams[teamId]) {
          gameState.teams[teamId].score += 10;
        }

        io.emit("result", {
          name: gameState.buzzedTeam.name,
          group: gameState.buzzedTeam.group,
          teamStep: 10,
          personalPoint: 1
        });
        gameState.buzzedTeam = null;
      } else {
        // SAI -> Khóa nhóm, GIỮ NGUYÊN ẨN ĐÁP ÁN để nhóm khác trả lời
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
    } catch (err) {
      console.error("Lỗi xử lý đáp án:", err);
    }
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

// Chống crash server khi có lỗi không mong muốn
process.on("uncaughtException", (err) => {
  console.error("Phát hiện lỗi hệ thống nhưng Server vẫn tiếp tục chạy:", err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server đang chạy ổn định tại: http://localhost:${PORT}`);
});
