const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Phục vụ tĩnh thư mục public (chứa screen.html, style.css, ...)
app.use(express.static(path.join(__dirname, "public")));

// Danh sách câu hỏi mẫu
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
  },
  {
    q: "Đơn vị tiền tệ chính thức của Việt Nam là gì?",
    options: ["USD", "Yên", "Đồng", "Euro"],
    answer: 2
  }
];

// Khởi tạo trạng thái trò chơi (Chỉ dành cho Nhóm 1, 3, 4, 5)
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
  // Gửi trạng thái hiện tại cho người dùng mới kết nối
  socket.emit("state", gameState);

  // Bắt đầu trò chơi từ MC
  socket.on("startGame", () => {
    gameState.started = true;
    io.emit("gameStarted");
    io.emit("state", gameState);
  });

  // MC mở câu hỏi mới
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

  // Xử lý khi có người BẤM CHUÔNG
  socket.on("buzz", (data) => {
    const groupStr = String(data.group);
    
    // Chỉ nhận chuông nếu chưa có ai bấm và nhóm đó chưa bị khóa ở câu này
    if (!gameState.buzzedTeam && !gameState.blockedTeams.includes(groupStr)) {
      gameState.buzzedTeam = data;
      
      // Phát sự kiện 'buzzed' để kích hoạt âm thanh tiếng chuông trên màn chiếu
      io.emit("buzzed", data);
      io.emit("state", gameState);

      // Đặt bộ đếm thời gian 10 giây trả lời
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

  // Xử lý khi người chơi NỘP ĐÁP ÁN
  socket.on("submitAnswer", (data) => {
    clearTimeout(questionTimer);
    const currentQ = gameState.questions[gameState.currentQuestion];

    if (!currentQ || !gameState.buzzedTeam) return;

    if (data.optionIndex === currentQ.answer) {
      // 1. TRẢ LỜI ĐÚNG
      gameState.answerRevealed = true;
      const teamId = String(gameState.buzzedTeam.group);
      
      if (gameState.teams[teamId]) {
        gameState.teams[teamId].score += 10;
      }

      // Phát sự kiện 'result' để màn chiếu chạy âm thanh chiến thắng & tung hô
      io.emit("result", {
        name: gameState.buzzedTeam.name,
        group: gameState.buzzedTeam.group,
        teamStep: 10,
        personalPoint: 1
      });
      gameState.buzzedTeam = null;
    } else {
      // 2. TRẢ LỜI SAI
      const failedGroup = String(gameState.buzzedTeam.group);
      gameState.blockedTeams.push(failedGroup);

      io.emit("wrong", {
        name: gameState.buzzedTeam.name,
        group: gameState.buzzedTeam.group,
        timedOut: false
      });
      gameState.buzzedTeam = null;

      // Nếu tất cả các nhóm tham gia đều đã trả lời sai -> Bỏ qua câu hỏi
      const activeGroups = Object.keys(gameState.teams);
      if (gameState.blockedTeams.length >= activeGroups.length) {
        gameState.answerRevealed = true;
        io.emit("questionSkipped");
      }
    }

    io.emit("state", gameState);
  });

  // MC reset chuông cho các nhóm còn lại cướp quyền
  socket.on("resetBuzz", () => {
    gameState.buzzedTeam = null;
    io.emit("resetBuzz");
    io.emit("state", gameState);
  });

  // MC kết thúc trò chơi
  socket.on("finishGame", () => {
    io.emit("gameFinished");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server Duck Race đang chạy tại http://localhost:${PORT}`);
});
