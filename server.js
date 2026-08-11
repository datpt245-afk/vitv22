const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

const teams = {};
for (let i=1;i<=5;i++) teams[i]={id:i,name:`Nhóm ${i}`,score:0,correct:0,members:{}};

let game = {
  teams,
  questions: [],
  currentQuestion: -1,
  questionOpen: false,
  locked:false,
  winner:null,
  race:[0,0,0,0,0],
  teamStep:2,
  personalPoint:1,
  history:[],
  answerRevealed:false
};

function snapshot(){ return JSON.parse(JSON.stringify(game)); }

io.on("connection", socket=>{
  socket.emit("state", snapshot());

  socket.on("joinMember", ({group,name})=>{
    group=String(group);
    name=String(name||"").trim().slice(0,40);
    if(!game.teams[group] || !name) return;
    if(!game.teams[group].members[name]) game.teams[group].members[name]={score:0,correct:0};
    socket.data.group=group; socket.data.name=name;
    socket.emit("joined",{group,name});
    io.emit("state",snapshot());
  });

  socket.on("buzz", ({group,name})=>{
    group=String(group); name=String(name||"");
    if(!game.questionOpen || game.locked || !game.teams[group]) return;
    if(!game.teams[group].members[name]) game.teams[group].members[name]={score:0,correct:0};
    game.locked=true;
    game.winner={group,name};
    io.emit("buzzed",{group,name});
    io.emit("state",snapshot());
  });

  socket.on("openQuestion", ({index})=>{
    index=Number(index);
    if(index<0 || index>=game.questions.length) return;
    game.currentQuestion=index;
    game.questionOpen=true;
    game.locked=false;
    game.winner=null;
    game.answerRevealed=false;
    io.emit("questionOpened",{index,question:game.questions[index]});
    io.emit("state",snapshot());
  });

  socket.on("nextQuestion",()=>{
    const next=game.currentQuestion+1;
    if(next<0 || next>=game.questions.length) return;
    game.currentQuestion=next;
    game.questionOpen=true;
    game.locked=false;
    game.winner=null;
    game.answerRevealed=false;
    io.emit("questionOpened",{index:next,question:game.questions[next]});
    io.emit("state",snapshot());
  });

  socket.on("closeQuestion",()=>{
    game.questionOpen=false; game.locked=true; game.winner=null;
    io.emit("state",snapshot());
  });

  socket.on("correct",()=>{
    if(!game.winner) return;
    const {group,name}=game.winner, t=game.teams[group];
    if(!t.members[name]) t.members[name]={score:0,correct:0};
    t.score += game.teamStep;
    t.correct += 1;
    t.members[name].score += game.personalPoint;
    t.members[name].correct += 1;
    game.race[Number(group)-1] = t.score;
    game.history.push({type:"correct",group,name,q:game.currentQuestion,time:Date.now()});
    game.questionOpen=false; 
    game.locked=true;
    game.answerRevealed=true; // Bật cờ để màn hình trình chiếu sáng đáp án đúng
    io.emit("result",{ok:true,group,name,teamStep:game.teamStep,personalPoint:game.personalPoint});
    io.emit("state",snapshot());
  });

  socket.on("wrong",()=>{
    if(!game.winner) return;
    const old=game.winner;
    game.history.push({type:"wrong",...old,q:game.currentQuestion,time:Date.now()});
    game.winner=null; game.locked=false; game.answerRevealed=false;
    io.emit("wrong",old);
    io.emit("state",snapshot());
  });

  socket.on("resetBuzz",()=>{
    if(game.questionOpen){
      game.winner=null; game.locked=false; game.answerRevealed=false;
      io.emit("resetBuzz");
      io.emit("state",snapshot());
    }
  });

  socket.on("saveQuestions",(questions)=>{
    if(!Array.isArray(questions)) return;
    game.questions=questions.map(q=>({
      q:String(q.q||""),
      options:Array.isArray(q.options)?q.options.slice(0,4).map(x=>String(x)):[],
      answer:Math.max(0,Math.min(3,Number(q.answer)||0))
    })).filter(q=>q.q && q.options.length===4);
    io.emit("questionsSaved",game.questions);
    io.emit("state",snapshot());
  });

  socket.on("setScoring",({teamStep,personalPoint})=>{
    game.teamStep=Math.max(1,Number(teamStep)||2);
    game.personalPoint=Math.max(1,Number(personalPoint)||1);
    io.emit("state",snapshot());
  });

  socket.on("resetGame",()=>{
    for(let i=1;i<=5;i++){
      game.teams[i].score=0; game.teams[i].correct=0; game.teams[i].members={};
    }
    game.race=[0,0,0,0,0]; game.currentQuestion=-1; game.questionOpen=false;
    game.locked=false; game.winner=null; game.history=[]; game.answerRevealed=false;
    io.emit("fullReset"); io.emit("state",snapshot());
  });
});

server.listen(3000,()=>console.log("DUCK RACE: http://localhost:3000"));
