
const express=require("express"),http=require("http"),{Server}=require("socket.io");
const app=express(),server=http.createServer(app),io=new Server(server),PORT=process.env.PORT||3000;
app.use(express.static("public"));
const S={started:false,finished:false,qi:-1,questions:[],teams:[1,2,3,4,5].map(id=>({id,name:"Nhóm "+id,score:0})),players:new Map(),inds:new Map(),locked:new Set(),active:null,timer:null,endsAt:null};
const pub=()=>({started:S.started,finished:S.finished,currentQuestion:S.qi,questionCount:S.questions.length,teams:S.teams,lockedGroups:[...S.locked],activeResponder:S.active,timerEndsAt:S.endsAt});
const bc=()=>io.emit("state",pub());
function clear(){if(S.timer)clearTimeout(S.timer);S.timer=null}
function next(){clear();S.active=null;S.endsAt=null;S.locked.clear();S.qi++;if(S.qi>=S.questions.length){S.started=false;S.finished=true;io.emit("gameFinished",{teams:S.teams,individuals:[...S.inds.values()].sort((a,b)=>b.score-a.score)});return bc()}io.emit("questionStarted",{number:S.qi+1});bc()}
function start(){if(!S.questions.length)return false;S.started=true;S.finished=false;S.qi=-1;S.teams.forEach(t=>t.score=0);S.inds.clear();next();return true}
function answer(id,idx,timeout=false){if(!S.active||S.active.socketId!==id)return;clear();let p=S.players.get(id),q=S.questions[S.qi],ok=!timeout&&Number(idx)===q.answer;if(ok){let pts=q.points||10,t=S.teams.find(t=>t.id===p.group);t.score+=pts;let k=p.group+":"+p.name,v=S.inds.get(k)||{name:p.name,group:p.group,score:0};v.score+=pts;S.inds.set(k,v);io.emit("answerResult",{correct:true,name:p.name,group:p.group,points:pts});S.active=null;S.endsAt=null;bc();setTimeout(()=>S.started&&!S.finished&&next(),1500)}else{S.locked.add(p.group);io.emit("answerResult",{correct:false,name:p.name,group:p.group,timedOut:timeout,points:0});S.active=null;S.endsAt=null;if(S.locked.size>=5){io.emit("questionSkipped",{number:S.qi+1});bc();setTimeout(()=>S.started&&!S.finished&&next(),1000)}else{io.emit("buzzReopened",{lockedGroups:[...S.locked]});bc()}}}
io.on("connection",s=>{
 s.emit("state",pub());
 s.on("joinPlayer",d=>{let name=String(d?.name||"").trim().slice(0,40),group=Number(d?.group);if(!name||group<1||group>5)return s.emit("joinError","Tên hoặc nhóm không hợp lệ.");S.players.set(s.id,{name,group});let k=group+":"+name;if(!S.inds.has(k))S.inds.set(k,{name,group,score:0});s.emit("joined",{name,group});bc()});
 s.on("buzz",()=>{if(!S.started||S.active)return;let p=S.players.get(s.id);if(!p||S.locked.has(p.group))return;let q=S.questions[S.qi];S.active={socketId:s.id,name:p.name,group:p.group};S.endsAt=Date.now()+10000;s.emit("answerAccess",{question:{q:q.q,options:q.options},endsAt:S.endsAt});io.emit("buzzWinner",{name:p.name,group:p.group});bc();S.timer=setTimeout(()=>answer(s.id,null,true),10000)});
 s.on("submitAnswer",i=>answer(s.id,Number(i),false));
 s.on("mcSaveQuestions",qs=>{if(S.started)return s.emit("mcError","Không thể sửa khi game đang chạy.");S.questions=(Array.isArray(qs)?qs:[]).map(q=>({q:String(q.q||"").trim(),options:Array.isArray(q.options)?q.options.slice(0,4).map(String):[],answer:Number(q.answer),points:Number(q.points)||10})).filter(q=>q.q&&q.options.length===4&&q.options.every(Boolean)&&q.answer>=0&&q.answer<=3);s.emit("mcQuestionsSaved",{count:S.questions.length});bc()});
 s.on("mcStart",()=>{if(!start())s.emit("mcError","Chưa có câu hỏi hợp lệ.")});
 s.on("mcReset",()=>{clear();S.started=false;S.finished=false;S.qi=-1;S.questions=[];S.teams.forEach(t=>t.score=0);S.players.clear();S.inds.clear();S.locked.clear();S.active=null;S.endsAt=null;io.emit("gameReset");bc()});
 s.on("disconnect",()=>{S.players.delete(s.id);if(S.active?.socketId===s.id)answer(s.id,null,true)});
});
server.listen(PORT,()=>console.log("Duck Race on "+PORT));
