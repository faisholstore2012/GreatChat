const express=require("express");
const http=require("http");
const path=require("path");
const fs=require("fs");
const bcrypt=require("bcryptjs");
const session=require("express-session");
const multer=require("multer");
const {Server}=require("socket.io");

const app=express(), server=http.createServer(app), io=new Server(server);
const PORT=process.env.PORT||3000;
const DB_FILE=path.join(__dirname,"data.json");
const uploadDir=path.join(__dirname,"uploads");
fs.mkdirSync(uploadDir,{recursive:true});

let db={users:[],messages:[],reactions:[],nextUserId:1,nextMessageId:1};
try{if(fs.existsSync(DB_FILE)) db={...db,...JSON.parse(fs.readFileSync(DB_FILE,"utf8"))}}catch(e){console.log("Membuat database baru...")}
function save(){fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2))}
function userById(id){return db.users.find(u=>u.id===Number(id))}
function safeUser(u){return u&&{id:u.id,username:u.username,created_at:u.created_at}}
function messageOut(m,userId){
 const u=userById(m.sender_id);
 const r=db.reactions.find(x=>x.message_id===m.id&&x.user_id===Number(userId));
 return {...m,sender_username:u?.username||"Unknown",reaction:r?.emoji||null};
}
function auth(req,res,next){if(!req.session.userId)return res.status(401).json({error:"Belum login"});next()}

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
 secret:process.env.SESSION_SECRET||"greatchat-change-this-secret",
 resave:false,saveUninitialized:false,
 cookie:{httpOnly:true,sameSite:"lax"}
}));
app.use("/uploads",express.static(uploadDir));
app.use(express.static(path.join(__dirname,"public")));

const upload=multer({
 dest:uploadDir,
 limits:{fileSize:10*1024*1024}
});

app.post("/api/register",async(req,res)=>{
 const username=String(req.body.username||"").trim();
 const password=String(req.body.password||"");
 if(!/^[A-Za-z0-9_]{3,24}$/.test(username))
   return res.status(400).json({error:"Username 3-24 karakter: huruf, angka, underscore."});
 if(password.length<6)return res.status(400).json({error:"Password minimal 6 karakter."});
 if(db.users.some(u=>u.username.toLowerCase()===username.toLowerCase()))
   return res.status(400).json({error:"Username sudah dipakai."});
 const hash=await bcrypt.hash(password,12);
 const u={id:db.nextUserId++,username,password_hash:hash,created_at:new Date().toISOString()};
 db.users.push(u);save();
 req.session.userId=u.id;
 res.json({user:safeUser(u)});
});

app.post("/api/login",async(req,res)=>{
 const username=String(req.body.username||"").trim(),password=String(req.body.password||"");
 const u=db.users.find(x=>x.username.toLowerCase()===username.toLowerCase());
 if(!u||!(await bcrypt.compare(password,u.password_hash)))
   return res.status(401).json({error:"Username atau password salah."});
 req.session.userId=u.id;res.json({user:safeUser(u)});
});

app.post("/api/logout",auth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({user:req.session.userId?safeUser(userById(req.session.userId)):null}));

app.get("/api/users",auth,(req,res)=>{
 res.json(db.users.filter(u=>u.id!==req.session.userId).map(safeUser).sort((a,b)=>a.username.localeCompare(b.username)));
});

app.get("/api/messages",auth,(req,res)=>{
 const rows=db.messages.filter(m=>m.room==="global").slice(-500).map(m=>messageOut(m,req.session.userId));
 res.json(rows);
});

app.post("/api/messages",auth,(req,res)=>{
 const text=String(req.body.text||"").trim();
 if(!text)return res.status(400).json({error:"Pesan kosong."});
 const m={id:db.nextMessageId++,sender_id:req.session.userId,receiver_id:null,room:"global",text,file_url:null,reply_to:req.body.reply_to||null,created_at:new Date().toISOString(),edited:0};
 db.messages.push(m);save();
 const out=messageOut(m,req.session.userId);io.emit("message:new",out);res.json(out);
});

app.post("/api/upload",auth,upload.single("file"),(req,res)=>{
 if(!req.file)return res.status(400).json({error:"File tidak ada."});
 const m={id:db.nextMessageId++,sender_id:req.session.userId,receiver_id:null,room:"global",text:"📎 "+req.file.originalname,file_url:"/uploads/"+req.file.filename,reply_to:null,created_at:new Date().toISOString(),edited:0};
 db.messages.push(m);save();
 const out=messageOut(m,req.session.userId);io.emit("message:new",out);res.json(out);
});

app.patch("/api/messages/:id",auth,(req,res)=>{
 const id=Number(req.params.id),text=String(req.body.text||"").trim();
 const m=db.messages.find(x=>x.id===id);
 if(!m||m.sender_id!==req.session.userId)return res.status(403).json({error:"Tidak diizinkan"});
 if(!text)return res.status(400).json({error:"Pesan kosong."});
 m.text=text;m.edited=1;save();
 io.emit("message:updated",{id,text,edited:1});res.json({ok:true});
});

app.delete("/api/messages/:id",auth,(req,res)=>{
 const id=Number(req.params.id),m=db.messages.find(x=>x.id===id);
 if(!m||m.sender_id!==req.session.userId)return res.status(403).json({error:"Tidak diizinkan"});
 db.messages=db.messages.filter(x=>x.id!==id);
 db.reactions=db.reactions.filter(x=>x.message_id!==id);
 save();io.emit("message:deleted",id);res.json({ok:true});
});

app.post("/api/messages/:id/reaction",auth,(req,res)=>{
 const id=Number(req.params.id),emoji=String(req.body.emoji||"❤️");
 const old=db.reactions.find(x=>x.message_id===id&&x.user_id===req.session.userId);
 if(old)db.reactions=db.reactions.filter(x=>x.id!==old.id);
 else db.reactions.push({id:Date.now(),message_id:id,user_id:req.session.userId,emoji});
 save();io.emit("reaction:changed",{messageId:id});res.json({ok:true});
});

const online=new Map();
io.on("connection",socket=>{
 socket.on("identify",username=>{
   if(username){online.set(socket.id,username);io.emit("presence",Array.from(new Set(online.values())));}
 });
 socket.on("typing",v=>socket.broadcast.emit("typing",v));
 socket.on("disconnect",()=>{online.delete(socket.id);io.emit("presence",Array.from(new Set(online.values())));});
});

server.listen(PORT,()=>console.log(`Great Chat: http://localhost:${PORT}`));
