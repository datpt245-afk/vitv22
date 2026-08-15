const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

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
  socket.emit("state", gameState);

  socket.on("startGame", () => {
    gameState.started = true;
    io.emit("gameStarted");
    io.emit("state", gameState);
  });

  socket.on("openQuestion", (index) => {
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
  });

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
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
