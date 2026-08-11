const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 10000,
  pingInterval: 5000
});

// Phục vụ các file giao diện static (HTML, CSS, JS) trong thư mục 'public'
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Đường dẫn file lưu trữ câu hỏi cố định trên đĩa
const QUESTIONS_FILE = path.join(__dirname, "questions.json");

// ==========================================
// 1. QUẢN LÝ ĐỌC / GHI CÂU HỎI TỪ FILE
// ==========================================

function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const data = fs.readFileSync(QUESTIONS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Lỗi khi đọc file questions.json:", err);
  }
  return [];
}

function saveQuestions(data) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Lỗi khi ghi file questions.json:", err);
  }
}

// Khai báo trạng thái Hệ thống
let questions = loadQuestions();

let gameState = {
  started: false,
  finished: false,
  currentQuestionIndex: -1,
  activeResponder: null, // { socketId, name, group }
  lockedGroups: [],      // Các nhóm bị khóa lượt ở câu hiện tại
  scores: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
};

let players = {}; // Lưu thông tin người chơi: socketId -> { name, group }

// ==========================================
// 2. XỬ LÝ KẾT NỐI SOCKET.IO
// ==========================================

io.on("connection", (socket) => {
  // --- A. DÀNH CHO MC & KHỞI TẠO DỮ LIỆU ---

  // Gửi danh sách câu hỏi và trạng thái game hiện tại cho người mới kết nối
  socket.emit("initQuestions", questions);
  socket.emit("state", gameState);
  socket.emit("updateScores", gameState.scores);

  // MC Thêm 1 câu hỏi mới
  socket.on("mc_addQuestion", (qData) => {
    questions.push(qData);
    saveQuestions(questions);
    io.emit("updateQuestions", questions);
  });

  // MC Xóa 1 câu hỏi
  socket.on("mc_deleteQuestion", (index) => {
    if (index >= 0 && index < questions.length) {
      questions.splice(index, 1);
      saveQuestions(questions);
      io.emit("updateQuestions", questions);
    }
  });

  // MC Import/Ghi đè danh sách câu hỏi
  socket.on("mc_importQuestions", (list) => {
    if (Array.isArray(list)) {
      questions = list;
      saveQuestions(questions);
      io.emit("updateQuestions", questions);
    }
  });

  // MC Bắt đầu câu hỏi mới (Mở chuông)
  socket.on("mc_startQuestion", (qIndex) => {
    if (qIndex >= 0 && qIndex < questions.length) {
      gameState.started = true;
      gameState.finished = false;
      gameState.currentQuestionIndex = qIndex;
      gameState.activeResponder = null;
      gameState.lockedGroups = [];
      
      io.emit("state", gameState);
      io.emit("questionStarted", questions[qIndex]);
    }
  });

  // MC Bỏ qua / Reset lượt bấm chuông của câu hiện tại
  socket.on("mc_resetBuzzer", () => {
    gameState.activeResponder = null;
    io.emit("state", gameState);
  });

  // MC Chốt kết quả Trả Lời (Đúng / Sai)
  socket.on("mc_judgeAnswer", (data) => {
    // data = { isCorrect: true/false, group: 1, points: 10 }
    if (data.isCorrect) {
      // Đúng: Cộng điểm, kết thúc câu hỏi
      gameState.scores[data.group] = (gameState.scores[data.group] || 0) + (data.points || 10);
      gameState.started = false;
      gameState.activeResponder = null;
      
      io.emit("updateScores", gameState.scores);
      io.emit("answerResult", { isCorrect: true, winnerGroup: data.group });
    } else {
      // Sai: Khóa nhóm đó, mở lại chuông cho các nhóm còn lại
      if (gameState.activeResponder) {
        if (!gameState.lockedGroups.includes(gameState.activeResponder.group)) {
          gameState.lockedGroups.push(gameState.activeResponder.group);
        }
      }
      gameState.activeResponder = null;
      io.emit("answerResult", { isCorrect: false, lockedGroup: data.group });
    }
    
    io.emit("state", gameState);
  });

  // MC Cập nhật điểm thủ công
  socket.on("mc_updateScore", ({ group, score }) => {
    gameState.scores[group] = Number(score) || 0;
    io.emit("updateScores", gameState.scores);
  });

  // MC Kết thúc/Reset toàn bộ Game
  socket.on("mc_resetGame", () => {
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
  });

  // --- B. DÀNH CHO NGƯỜI CHƠI (PLAYER) ---

  // Người chơi tham gia phòng
  socket.on("joinPlayer", (playerData) => {
    if (!playerData || !playerData.name || !playerData.group) {
      socket.emit("joinError", "Thông tin không hợp lệ!");
      return;
    }
    
    players[socket.id] = playerData;
    socket.emit("joined", playerData);
    
    // Gửi danh sách người chơi hiện tại cho MC
    io.emit("updatePlayerList", Object.values(players));
    socket.emit("state", gameState);
  });

  // Người chơi bấm chuông
  socket.on("buzz", () => {
    const p = players[socket.id];
    if (!p) return;

    // Kiểm tra điều kiện bấm chuông hợp lệ
    if (
      gameState.started &&
      !gameState.activeResponder &&
      !gameState.lockedGroups.includes(p.group)
    ) {
      gameState.activeResponder = {
        socketId: socket.id,
        name: p.name,
        group: p.group
      };

      // Phát tín hiệu chuông thắng cho tất cả mọi người
      io.emit("buzzWinner", gameState.activeResponder);
      io.emit("state", gameState);

      // Cấp quyền mở trang nhập/trả lời cho người bấm nhanh nhất
      const currentQ = questions[gameState.currentQuestionIndex];
      socket.emit("answerAccess", {
        question: currentQ,
        player: p
      });
    }
  });

  // --- C. NGẮT KẾT NỐI ---
  socket.on("disconnect", () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit("updatePlayerList", Object.values(players));
    }
  });
});

// ==========================================
// 3. KHỞI CHẠY SERVER
// ==========================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=============================================`);
  console.log(`🚀 Server Game Chuông đang chạy tại PORT: ${PORT}`);
  console.log(`=============================================`);
});
