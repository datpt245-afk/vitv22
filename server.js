const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/mc", (req, res) => res.sendFile(path.join(__dirname, "mc.html")));
app.get("/screen", (req, res) => res.sendFile(path.join(__dirname, "screen.html")));
app.get("/answer.html", (req, res) => res.sendFile(path.join(__dirname, "answer.html")));

const S = {
  started: false,
  finished: false,
  qi: -1,
  questions: [],
  teams: [1, 2, 3, 4, 5].map(id => ({ id, name: "Nhóm " + id, score: 0 })),
  players: new Map(),
  inds: new Map(),
  locked: new Set(),
  active: null,
  timer: null,
  endsAt: null
};

const pub = () => ({
  started: S.started,
  finished: S.finished,
  currentQuestion: S.qi,
  questionCount: S.questions.length,
  teams: S.teams,
  individuals: [...S.inds.values()].sort((a, b) => b.score - a.score),
  lockedGroups: [...S.locked],
  activeResponder: S.active,
  timerEndsAt: S.endsAt,
  playerList: [...S.players.values()]
});

const bc = () => io.emit("state", pub());

function clear() {
  if (S.timer) clearTimeout(S.timer);
  S.timer = null;
}

function nextQuestion() {
  clear();
  S.active = null;
  S.endsAt = null;
  S.locked.clear();
  S.qi++;
  
  if (S.qi >= S.questions.length) {
    S.started = false;
    S.finished = true;
    io.emit("gameFinished", {
      teams: S.teams,
      individuals: [...S.inds.values()].sort((a, b) => b.score - a.score)
    });
    return bc();
  }
  
  io.emit("questionStarted", { number: S.qi + 1, question: S.questions[S.qi] });
  bc();
}

function start() {
  if (!S.questions.length) return false;
  S.started = true;
  S.finished = false;
  S.qi = -1;
  S.teams.forEach(t => (t.score = 0));
  S.inds.clear();
  nextQuestion();
  return true;
}

function answer(id, idx, timeout = false, pInfo = null) {
  if (!S.active) return;
  clear();
  
  let p = S.players.get(id) || pInfo || S.active;
  let q = S.questions[S.qi];
  
  let ok = !timeout && idx !== null && idx !== undefined && Number(idx) === q.answer;

  if (ok) {
    let groupPts = q.groupPoints !== undefined ? q.groupPoints : 10;
    let indPts = q.indPoints !== undefined ? q.indPoints : 10;

    // Cộng điểm Nhóm
    let t = S.teams.find(t => t.id === p.group);
    if (t) t.score += groupPts;
    
    // Cộng điểm Cá nhân
    let k = p.group + ":" + p.name;
    let v = S.inds.get(k) || { name: p.name, group: p.group, score: 0 };
    v.score += indPts;
    S.inds.set(k, v);

    io.emit("answerResult", { 
      correct: true, 
      name: p.name, 
      group: p.group, 
      groupPoints: groupPts,
      indPoints: indPts 
    });
    S.active = null;
    S.endsAt = null;
    bc();
    setTimeout(() => S.started && !S.finished && nextQuestion(), 1500);
  } else {
    S.locked.add(p.group);
    io.emit("answerResult", { correct: false, name: p.name, group: p.group, timedOut: timeout, points: 0 });
    S.active = null;
    S.endsAt = null;
    if (S.locked.size >= 5) {
      io.emit("questionSkipped", { number: S.qi + 1 });
      bc();
      setTimeout(() => S.started && !S.finished && nextQuestion(), 1000);
    } else {
      io.emit("buzzReopened", { lockedGroups: [...S.locked] });
      bc();
    }
  }
}

io.on("connection", s => {
  s.emit("state", pub());

  s.on("joinPlayer", d => {
    let name = String(d?.name || "").trim().slice(0, 40);
    let group = Number(d?.group);
    if (!name || group < 1 || group > 5) return s.emit("joinError", "Tên hoặc nhóm không hợp lệ.");
    
    S.players.set(s.id, { name, group });
    let k = group + ":" + name;
    if (!S.inds.has(k)) S.inds.set(k, { name, group, score: 0 });
    s.emit("joined", { name, group });
    bc();
  });

  s.on("buzz", () => {
    if (!S.started || S.active) return;
    let p = S.players.get(s.id);
    if (!p || S.locked.has(p.group)) return;
    let q = S.questions[S.qi];
    
    S.active = { socketId: s.id, name: p.name, group: p.group };
    S.endsAt = Date.now() + 10000;
    
    s.emit("answerAccess", { 
      question: { q: q.q, options: q.options }, 
      endsAt: S.endsAt, 
      name: p.name, 
      group: p.group 
    });
    io.emit("buzzWinner", { name: p.name, group: p.group });
    bc();
    
    S.timer = setTimeout(() => answer(s.id, null, true), 10000);
  });

  s.on("submitAnswer", d => {
    let index = typeof d === 'object' ? d.index : d;
    let pInfo = typeof d === 'object' ? { name: d.name, group: d.group } : null;
    answer(s.id, Number(index), false, pInfo);
  });

  s.on("mcSaveQuestions", payload => {
    if (S.started) return s.emit("mcError", "Không thể sửa khi game đang chạy.");
    
    let qs = Array.isArray(payload) ? payload : (payload.questions || []);
    let gPts = typeof payload === 'object' && payload.globalGroupPoints !== undefined ? Number(payload.globalGroupPoints) : 10;
    let iPts = typeof payload === 'object' && payload.globalIndPoints !== undefined ? Number(payload.globalIndPoints) : 10;

    S.questions = qs
      .map(q => ({
        q: String(q.q || "").trim(),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [],
        answer: Number(q.answer),
        groupPoints: gPts,
        indPoints: iPts
      }))
      .filter(q => q.q && q.options.length === 4 && q.options.every(Boolean) && q.answer >= 0 && q.answer <= 3);
    
    s.emit("mcQuestionsSaved", { count: S.questions.length, groupPts: gPts, indPts: iPts });
    bc();
  });

  s.on("mcStart", () => {
    if (!start()) s.emit("mcError", "Chưa có câu hỏi hợp lệ.");
  });

  s.on("mcReset", () => {
    clear();
    S.started = false;
    S.finished = false;
    S.qi = -1;
    S.questions = [];
    S.teams.forEach(t => (t.score = 0));
    S.players.clear();
    S.inds.clear();
    S.locked.clear();
    S.active = null;
    S.endsAt = null;
    io.emit("gameReset");
    bc();
  });

  s.on("mcAdjustTeamScore", d => {
    let t = S.teams.find(t => t.id === Number(d.teamId));
    if (t) {
      t.score += Number(d.points) || 0;
      bc();
    }
  });

  s.on("mcAdjustIndScore", d => {
    let k = String(d.playerKey);
    let v = S.inds.get(k);
    if (!v) {
      let parts = k.split(":");
      v = { name: parts[1] || "", group: Number(parts[0]) || 1, score: 0 };
    }
    v.score += Number(d.points) || 0;
    S.inds.set(k, v);
    bc();
  });

  s.on("disconnect", () => {
    S.players.delete(s.id);
    bc();
  });
});

server.listen(PORT, () => console.log("Duck Race running on port " + PORT));
