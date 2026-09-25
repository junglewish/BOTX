import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const STORAGE_DIR = process.env.BOTX_STORAGE_DIR || path.join(__dirname, "runtime");
const DATA_DIR = path.join(STORAGE_DIR, "data");
const SESSION_DIR = path.join(STORAGE_DIR, "sessions");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "botx.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT 'My WhatsApp Bot',
    phone TEXT,
    prefix TEXT NOT NULL DEFAULT '.',
    status TEXT NOT NULL DEFAULT 'DISCONNECTED',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));


function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
}

function getUser(req) {
  return db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(req.session.userId);
}

function getBotForUser(userId) {
  let bot = db.prepare("SELECT * FROM bots WHERE user_id = ?").get(userId);
  if (!bot) {
    const result = db.prepare(
      "INSERT INTO bots (user_id, name) VALUES (?, ?)"
    ).run(userId, "My WhatsApp Bot");
    bot = db.prepare("SELECT * FROM bots WHERE id = ?").get(result.lastInsertRowid);
  }
  return bot;
}

const instances = new Map();

function sessionPath(botId) {
  return path.join(SESSION_DIR, `bot-${botId}`);
}

function setBotStatus(botId, status, phone = undefined) {
  if (phone !== undefined) {
    db.prepare("UPDATE bots SET status = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status, phone, botId);
  } else {
    db.prepare("UPDATE bots SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status, botId);
  }
}

function normalizePhone(input) {
  return String(input || "").replace(/\D/g, "");
}

async function startBot(botId, requestedPhone = null) {
  if (instances.has(botId)) {
    return instances.get(botId);
  }

  const bot = db.prepare("SELECT * FROM bots WHERE id = ?").get(botId);
  if (!bot) throw new Error("Bot not found");

  const authDir = sessionPath(botId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false
  });

  const instance = {
    botId,
    sock,
    state,
    saveCreds,
    pairingCode: null,
    pairingRequested: false
  };

  instances.set(botId, instance);
  setBotStatus(botId, state.creds.registered ? "CONNECTING" : "PAIRING");

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      const phone = state.creds.me?.id?.split(":")[0]?.split("@")[0] || bot.phone;
      setBotStatus(botId, "CONNECTED", phone);
      instance.pairingCode = null;
      instance.pairingRequested = false;
      logger.info({ botId, phone }, "WhatsApp connected");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      instances.delete(botId);

      if (loggedOut) {
        setBotStatus(botId, "DISCONNECTED");
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch {}
      } else {
        setBotStatus(botId, "DISCONNECTED");
        // Small reconnect delay. Avoid a tight reconnect loop.
        setTimeout(() => {
          startBot(botId).catch((err) => logger.error({ err, botId }, "Reconnect failed"));
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      try {
        if (!message.message || message.key.fromMe) continue;

        const remoteJid = message.key.remoteJid;
        if (!remoteJid) continue;

        const msgText =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          message.message.imageMessage?.caption ||
          message.message.videoMessage?.caption ||
          "";

        const currentBot = db.prepare("SELECT prefix FROM bots WHERE id = ?").get(botId);
        const prefix = currentBot?.prefix || ".";

        if (!msgText.startsWith(prefix)) continue;

        const body = msgText.slice(prefix.length).trim();
        if (!body) continue;

        const [command, ...args] = body.split(/\s+/);
        const cmd = command.toLowerCase();

        if (cmd === "ping") {
          await sock.sendMessage(remoteJid, { text: "🏓 Pong!" });
        } else if (cmd === "menu") {
          await sock.sendMessage(remoteJid, {
            text:
`🤖 BOTX MENU

${prefix}ping
${prefix}menu
${prefix}status

Bot: ${currentBot?.name || "My WhatsApp Bot"}`
          });
        } else if (cmd === "status") {
          await sock.sendMessage(remoteJid, {
            text: `🟢 Bot is connected.\nPrefix: ${prefix}`
          });
        }
      } catch (err) {
        logger.error({ err, botId }, "Command handling error");
      }
    }
  });

  if (!state.creds.registered && requestedPhone) {
    const phone = normalizePhone(requestedPhone);
    if (phone.length < 8 || phone.length > 15) {
      throw new Error("Enter a valid international phone number, e.g. 254712345678");
    }

    // Give the socket a moment to establish its initial connection.
    await new Promise(resolve => setTimeout(resolve, 1500));

    const code = await sock.requestPairingCode(phone);
    instance.pairingCode = code;
    instance.pairingRequested = true;
    setBotStatus(botId, "PAIRING", phone);
  }

  return instance;
}

app.post("/api/auth/signup", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({
        error: "Username must be 3–24 characters using letters, numbers or underscore."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (exists) return res.status(409).json({ error: "Username already exists." });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)"
    ).run(username, passwordHash);

    req.session.userId = Number(result.lastInsertRowid);
    getBotForUser(req.session.userId);

    res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  req.session.userId = user.id;
  getBotForUser(user.id);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = getUser(req);
  const bot = getBotForUser(user.id);
  const instance = instances.get(bot.id);

  res.json({
    user: { username: user.username },
    bot: {
      id: bot.id,
      name: bot.name,
      phone: bot.phone,
      prefix: bot.prefix,
      status: instance?.sock ? bot.status : bot.status
    }
  });
});

app.get("/api/bot", requireAuth, (req, res) => {
  const bot = getBotForUser(req.session.userId);
  res.json({
    id: bot.id,
    name: bot.name,
    phone: bot.phone,
    prefix: bot.prefix,
    status: bot.status
  });
});

app.patch("/api/bot", requireAuth, (req, res) => {
  const bot = getBotForUser(req.session.userId);
  const name = String(req.body.name ?? bot.name).trim().slice(0, 60);
  const prefix = String(req.body.prefix ?? bot.prefix).trim();

  if (!prefix || prefix.length > 3 || /\s/.test(prefix)) {
    return res.status(400).json({ error: "Prefix must be 1–3 non-space characters." });
  }

  db.prepare(
    "UPDATE bots SET name = ?, prefix = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(name || "My WhatsApp Bot", prefix, bot.id);

  res.json({ ok: true });
});

app.post("/api/bot/pair", requireAuth, async (req, res) => {
  try {
    const bot = getBotForUser(req.session.userId);
    const phone = normalizePhone(req.body.phone);

    if (!phone) return res.status(400).json({ error: "WhatsApp phone number is required." });

    const existing = instances.get(bot.id);
    if (existing?.pairingCode) {
      return res.json({ ok: true, code: existing.pairingCode, status: "PAIRING" });
    }

    const instance = await startBot(bot.id, phone);
    res.json({
      ok: true,
      code: instance.pairingCode,
      status: "PAIRING"
    });
  } catch (err) {
    logger.error({ err }, "Pairing error");
    res.status(500).json({ error: err.message || "Could not generate pairing code." });
  }
});

app.post("/api/bot/start", requireAuth, async (req, res) => {
  try {
    const bot = getBotForUser(req.session.userId);
    await startBot(bot.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not start bot." });
  }
});

app.post("/api/bot/stop", requireAuth, async (req, res) => {
  const bot = getBotForUser(req.session.userId);
  const instance = instances.get(bot.id);

  if (instance) {
    try {
      instance.sock.end(undefined);
    } catch {}
    instances.delete(bot.id);
  }

  setBotStatus(bot.id, "DISCONNECTED");
  res.json({ ok: true });
});

// On startup, reconnect accounts that already have local auth.
for (const dir of fs.readdirSync(SESSION_DIR, { withFileTypes: true })) {
  if (!dir.isDirectory() || !dir.name.startsWith("bot-")) continue;
  const botId = Number(dir.name.replace("bot-", ""));
  if (!Number.isInteger(botId)) continue;
  const authCreds = path.join(SESSION_DIR, dir.name, "creds.json");
  if (fs.existsSync(authCreds)) {
    startBot(botId).catch(err => logger.error({ err, botId }, "Startup reconnect failed"));
  }
}




// Embedded dashboard: the complete frontend lives inside this server.js file.
const INDEX_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>BOTX</title>\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\n:root{--bg:#03040a;--panel:rgba(10,12,22,.72);--line:rgba(255,255,255,.09);--muted:#9299ad;--accent:#756cff;--green:#35e99a}\nbody{min-height:100vh;background:#03040a;color:#f6f7ff;font-family:Inter,system-ui,Arial,sans-serif;overflow-x:hidden}\nbutton,input{font:inherit}\nbutton{cursor:pointer}\n.bg{position:fixed;inset:0;overflow:hidden;z-index:-5;background:radial-gradient(circle at 15% 15%,rgba(96,74,255,.12),transparent 30%),radial-gradient(circle at 85% 75%,rgba(0,208,255,.08),transparent 30%),#03040a}\n.orb{position:absolute;border-radius:50%;width:6px;height:6px;box-shadow:0 0 18px currentColor,0 0 50px currentColor;animation:drift 13s ease-in-out infinite alternate}\n.o1{left:15%;top:22%;color:#7b6cff}.o2{left:74%;top:18%;color:#00d9ff;animation-duration:17s}.o3{left:42%;top:78%;color:#ff3cae;animation-duration:19s}.o4{left:87%;top:58%;color:#35e99a;animation-duration:14s}.o5{left:28%;top:86%;color:#ff9f43;animation-duration:22s}\n@keyframes drift{0%{transform:translate(0,0) scale(1)}25%{transform:translate(130px,-90px) scale(1.5)}50%{transform:translate(-80px,100px) scale(.7)}75%{transform:translate(160px,120px) scale(1.8)}100%{transform:translate(-110px,-90px) scale(1)}}\n.streak{position:absolute;width:320px;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent);opacity:.18;transform:rotate(-25deg);animation:streak 9s linear infinite}.s1{top:22%;left:-350px}.s2{top:64%;left:-450px;animation-delay:3s}.s3{top:44%;left:-500px;animation-delay:6s}@keyframes streak{to{transform:translateX(150vw) rotate(-25deg)}}\n.screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px}\n.auth{width:min(420px,100%);padding:30px;border:1px solid var(--line);background:rgba(8,10,18,.78);backdrop-filter:blur(24px);border-radius:25px;box-shadow:0 30px 100px rgba(0,0,0,.4)}\n.logo{font-size:28px;font-weight:900;letter-spacing:-1px}.logo b{color:#786fff}.sub{color:var(--muted);font-size:13px;margin-top:7px;margin-bottom:28px}\n.field{margin:14px 0}.field label{display:block;color:#aeb4c5;font-size:12px;margin-bottom:7px}.field input{width:100%;padding:13px 14px;border-radius:13px;border:1px solid var(--line);outline:none;background:rgba(255,255,255,.035);color:white}.field input:focus{border-color:rgba(117,108,255,.65);box-shadow:0 0 0 3px rgba(117,108,255,.08)}\n.btn{position:relative;overflow:hidden;border:1px solid rgba(117,108,255,.35);background:rgba(117,108,255,.14);color:white;padding:12px 17px;border-radius:13px;font-weight:700;transition:.25s;isolation:isolate}.btn:before{content:\"\";position:absolute;left:var(--x,50%);top:var(--y,50%);width:12px;height:12px;border-radius:50%;background:radial-gradient(circle,white,rgba(117,108,255,.65) 32%,transparent 72%);transform:translate(-50%,-50%) scale(0);z-index:-1;transition:transform .6s}.btn.flash:before{transform:translate(-50%,-50%) scale(38)}.btn:hover{box-shadow:0 0 28px rgba(117,108,255,.22);border-color:rgba(150,140,255,.7)}.btn:active{transform:scale(.97)}.primary{background:linear-gradient(135deg,rgba(117,108,255,.4),rgba(155,70,255,.18))}.full{width:100%}.switch{margin-top:17px;text-align:center;color:var(--muted);font-size:12px}.switch button{background:none;border:0;color:#9c94ff;font-weight:700}\n.error{color:#ff718d;font-size:12px;min-height:18px;margin-top:8px}\n.app{min-height:100vh;display:none}.side{position:fixed;left:0;top:0;bottom:0;width:245px;padding:25px 16px;background:rgba(5,7,14,.76);border-right:1px solid var(--line);backdrop-filter:blur(25px);z-index:20;transition:.3s}.brand{font-size:23px;font-weight:900;margin:0 10px 40px}.brand b{color:#786fff}.nav{display:grid;gap:7px}.nav button{border:0;background:transparent;color:#9299ad;text-align:left;padding:13px 15px;border-radius:13px}.nav button:hover,.nav button.active{color:white;background:rgba(117,108,255,.13);box-shadow:inset 3px 0 #756cff}.sideBottom{position:absolute;bottom:22px;left:16px;right:16px;padding:14px;border:1px solid var(--line);border-radius:15px;background:rgba(255,255,255,.025);font-size:13px}.sideBottom small{color:var(--muted)}\n.main{width:100%;margin-left:245px;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px}.mobile{display:none;background:none;border:0;color:white;font-size:24px}.title h1{font-size:34px}.title p{color:var(--muted);font-size:13px;margin-top:5px}.avatar{width:43px;height:43px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#7168ff,#b448ff);font-weight:800;box-shadow:0 0 25px rgba(117,108,255,.25)}\n.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-bottom:17px}.card,.panel{border:1px solid var(--line);background:var(--panel);backdrop-filter:blur(20px);border-radius:21px}.card{padding:20px;min-height:130px;position:relative;overflow:hidden}.label{color:var(--muted);font-size:12px}.value{font-size:28px;font-weight:850;margin-top:13px}.green{color:var(--green)}.purple{color:#9189ff}.orange{color:#ffb057}.glow{position:absolute;right:-40px;bottom:-50px;width:110px;height:110px;border-radius:50%;background:#756cff;filter:blur(45px);opacity:.18}\n.grid{display:grid;grid-template-columns:1.35fr .75fr;gap:17px}.panel{padding:22px}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.head h2{font-size:16px}.muted{color:var(--muted);font-size:12px}.bot{display:flex;justify-content:space-between;align-items:center;padding:16px;border-radius:16px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);margin-bottom:14px}.botLeft{display:flex;gap:12px;align-items:center}.botIcon{width:46px;height:46px;border-radius:14px;background:rgba(117,108,255,.14);display:grid;place-items:center;font-size:20px}.phone{font-size:12px;color:var(--muted);margin-top:4px}.status{font-size:12px;color:var(--green);display:flex;gap:6px;align-items:center}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}\n.actions{display:flex;gap:9px;flex-wrap:wrap}.input{width:100%;padding:12px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid var(--line);color:white;outline:none}.row{display:flex;gap:9px}.setting{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.06)}.setting:last-child{border-bottom:0}.desc{font-size:11px;color:var(--muted);margin-top:4px}.toggle{width:43px;height:24px;border-radius:20px;background:#252938;position:relative;transition:.25s}.toggle:after{content:\"\";position:absolute;width:18px;height:18px;border-radius:50%;background:#777d91;top:3px;left:3px;transition:.25s}.toggle.on{background:rgba(117,108,255,.45)}.toggle.on:after{left:22px;background:#9088ff;box-shadow:0 0 12px #756cff}\n.circle{width:150px;height:150px;margin:10px auto 18px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle,#0b0d16 58%,transparent 60%),conic-gradient(#756cff 0deg 285deg,#202331 285deg);box-shadow:0 0 45px rgba(117,108,255,.15);position:relative}.circle:before{content:\"\";position:absolute;inset:-5px;border-radius:50%;border:1px solid rgba(117,108,255,.25);animation:pulse 2.5s infinite}@keyframes pulse{50%{transform:scale(1.08);opacity:.8}}.days{text-align:center;font-size:29px;font-weight:900}.days small{display:block;font-size:10px;color:var(--muted);font-weight:500}\n.modal{position:fixed;inset:0;background:rgba(0,0,0,.66);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:18px;z-index:100}.modal.show{display:flex}.modalBox{width:min(520px,100%);padding:23px;border-radius:21px;border:1px solid var(--line);background:#090b14;box-shadow:0 30px 100px #000}.modalTop{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.close{background:none;border:0;color:#aaa;font-size:23px}.code{font-size:30px;letter-spacing:5px;text-align:center;font-weight:900;padding:22px;border:1px dashed rgba(117,108,255,.5);border-radius:17px;background:rgba(117,108,255,.06);margin:18px 0}.help{line-height:1.7;color:#b5bac8;font-size:13px}.toast{position:fixed;bottom:22px;left:50%;transform:translate(-50%,30px);opacity:0;padding:12px 17px;border-radius:12px;background:rgba(18,20,31,.94);border:1px solid var(--line);backdrop-filter:blur(15px);font-size:12px;z-index:200;transition:.3s}.toast.show{opacity:1;transform:translate(-50%,0)}\n.page{display:none}.page.active{display:block}\n@media(max-width:1050px){.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}\n@media(max-width:750px){.side{transform:translateX(-100%);width:270px}.side.open{transform:none}.main{margin-left:0;padding:19px 14px}.mobile{display:block}.title h1{font-size:26px}.cards{grid-template-columns:1fr 1fr;gap:9px}.card{min-height:112px;padding:16px}.value{font-size:23px}.bot{flex-direction:column;align-items:flex-start;gap:12px}}\n@media(max-width:450px){.cards{grid-template-columns:1fr}.avatar{display:none}}\n</style>\n</head>\n<body>\n\n<div class=\"bg\">\n  <i class=\"orb o1\"></i><i class=\"orb o2\"></i><i class=\"orb o3\"></i><i class=\"orb o4\"></i><i class=\"orb o5\"></i>\n  <i class=\"streak s1\"></i><i class=\"streak s2\"></i><i class=\"streak s3\"></i>\n</div>\n\n<div id=\"authScreen\" class=\"screen\">\n  <div class=\"auth\">\n    <div class=\"logo\">BOT<b>X</b></div>\n    <div class=\"sub\">WhatsApp bot control center</div>\n\n    <div id=\"loginForm\">\n      <div class=\"field\"><label>Username</label><input id=\"loginUser\" autocomplete=\"username\"></div>\n      <div class=\"field\"><label>Password</label><input id=\"loginPass\" type=\"password\" autocomplete=\"current-password\"></div>\n      <button class=\"btn primary full\" data-glow onclick=\"login()\">Sign in</button>\n      <div class=\"error\" id=\"loginError\"></div>\n      <div class=\"switch\">No account? <button onclick=\"showAuth('signup')\">Create one</button></div>\n    </div>\n\n    <div id=\"signupForm\" style=\"display:none\">\n      <div class=\"field\"><label>Username</label><input id=\"signupUser\" autocomplete=\"username\"></div>\n      <div class=\"field\"><label>Password</label><input id=\"signupPass\" type=\"password\" autocomplete=\"new-password\"></div>\n      <div class=\"field\"><label>Confirm password</label><input id=\"signupPass2\" type=\"password\" autocomplete=\"new-password\"></div>\n      <button class=\"btn primary full\" data-glow onclick=\"signup()\">Create account</button>\n      <div class=\"error\" id=\"signupError\"></div>\n      <div class=\"switch\">Already registered? <button onclick=\"showAuth('login')\">Sign in</button></div>\n    </div>\n  </div>\n</div>\n\n<div id=\"app\" class=\"app\">\n  <aside class=\"side\" id=\"side\">\n    <div class=\"brand\">BOT<b>X</b></div>\n    <div class=\"nav\">\n      <button class=\"active\" onclick=\"page('dashboard',this)\">◈ &nbsp; Dashboard</button>\n      <button onclick=\"page('bot',this)\">◉ &nbsp; My Bot</button>\n      <button onclick=\"page('settings',this)\">⚙ &nbsp; Settings</button>\n      <button onclick=\"page('help',this)\">?</button>\n      <button onclick=\"page('privacy',this)\">⌁ &nbsp; Privacy</button>\n      <button onclick=\"page('about',this)\">ⓘ &nbsp; About</button>\n      <button onclick=\"logout()\">↪ &nbsp; Sign out</button>\n    </div>\n    <div class=\"sideBottom\"><strong id=\"sideUser\">Account</strong><br><small>Connected dashboard</small></div>\n  </aside>\n\n  <main class=\"main\">\n    <header class=\"top\">\n      <button class=\"mobile\" onclick=\"document.getElementById('side').classList.toggle('open')\">☰</button>\n      <div class=\"title\"><h1 id=\"pageTitle\">Dashboard</h1><p id=\"pageSub\">Control your WhatsApp bot.</p></div>\n      <div class=\"avatar\" id=\"avatar\">B</div>\n    </header>\n\n    <section id=\"dashboard\" class=\"page active\">\n      <div class=\"cards\">\n        <div class=\"card\"><div class=\"label\">Bot status</div><div class=\"value green\" id=\"statStatus\">Offline</div><div class=\"glow\"></div></div>\n        <div class=\"card\"><div class=\"label\">Commands</div><div class=\"value purple\">3</div><div class=\"glow\"></div></div>\n        <div class=\"card\"><div class=\"label\">Prefix</div><div class=\"value\" id=\"statPrefix\">.</div><div class=\"glow\"></div></div>\n        <div class=\"card\"><div class=\"label\">Account</div><div class=\"value purple\">Active</div><div class=\"glow\"></div></div>\n      </div>\n      <div class=\"grid\">\n        <div class=\"panel\">\n          <div class=\"head\"><h2>My Bot</h2><span class=\"muted\" id=\"liveLabel\">OFFLINE</span></div>\n          <div class=\"bot\">\n            <div class=\"botLeft\"><div class=\"botIcon\">🤖</div><div><strong id=\"botName\">My WhatsApp Bot</strong><div class=\"phone\" id=\"botPhone\">Not linked</div></div></div>\n            <div class=\"status\" id=\"statusText\"><span class=\"dot\"></span> Offline</div>\n          </div>\n          <div class=\"actions\">\n            <button class=\"btn primary\" data-glow onclick=\"openPair()\">Connect WhatsApp</button>\n            <button class=\"btn\" data-glow onclick=\"startBot()\">Start bot</button>\n            <button class=\"btn\" data-glow onclick=\"stopBot()\">Stop bot</button>\n          </div>\n        </div>\n        <div class=\"panel\">\n          <div class=\"head\"><h2>Quick Settings</h2><span class=\"muted\">LOCAL UI</span></div>\n          <div class=\"setting\"><div><strong>Auto Status</strong><div class=\"desc\">Ready for engine integration</div></div><div class=\"toggle on\" onclick=\"this.classList.toggle('on')\"></div></div>\n          <div class=\"setting\"><div><strong>Anti ViewOnce</strong><div class=\"desc\">Feature switch</div></div><div class=\"toggle on\" onclick=\"this.classList.toggle('on')\"></div></div>\n          <div class=\"setting\"><div><strong>Auto Read</strong><div class=\"desc\">Mark messages as read</div></div><div class=\"toggle\" onclick=\"this.classList.toggle('on')\"></div></div>\n        </div>\n      </div>\n    </section>\n\n    <section id=\"bot\" class=\"page\">\n      <div class=\"panel\">\n        <div class=\"head\"><h2>My Bot</h2><span class=\"muted\" id=\"botPageStatus\">OFFLINE</span></div>\n        <div class=\"field\"><label>Bot name</label><input class=\"input\" id=\"botNameInput\"></div>\n        <div class=\"field\"><label>Command prefix</label><input class=\"input\" id=\"prefixInput\" maxlength=\"3\"></div>\n        <div class=\"actions\"><button class=\"btn primary\" data-glow onclick=\"saveBot()\">Save changes</button><button class=\"btn\" data-glow onclick=\"openPair()\">Pair WhatsApp</button></div>\n      </div>\n    </section>\n\n    <section id=\"settings\" class=\"page\">\n      <div class=\"panel\">\n        <div class=\"head\"><h2>Settings</h2></div>\n        <div class=\"setting\"><div><strong>Auto Status</strong><div class=\"desc\">Interface setting; engine hook can be added later.</div></div><div class=\"toggle on\" onclick=\"this.classList.toggle('on')\"></div></div>\n        <div class=\"setting\"><div><strong>Anti ViewOnce</strong><div class=\"desc\">Interface setting; engine hook can be added later.</div></div><div class=\"toggle on\" onclick=\"this.classList.toggle('on')\"></div></div>\n        <div class=\"setting\"><div><strong>Notifications</strong><div class=\"desc\">Dashboard notifications.</div></div><div class=\"toggle on\" onclick=\"this.classList.toggle('on')\"></div></div>\n      </div>\n    </section>\n\n    <section id=\"help\" class=\"page\"><div class=\"panel\"><div class=\"head\"><h2>Help</h2></div><div class=\"help\">To connect your WhatsApp, tap <b>Connect WhatsApp</b>, enter your number in international format without + (for example 254712345678), then enter the generated pairing code in WhatsApp under Linked Devices → Link with phone number. Once linked, return here and the status should become Connected.<br><br>Commands currently included: <b>.ping</b>, <b>.menu</b>, and <b>.status</b>. Your chosen prefix is used by the live bot.</div></div></section>\n\n    <section id=\"privacy\" class=\"page\"><div class=\"panel\"><div class=\"head\"><h2>Privacy</h2></div><div class=\"help\">Your username is stored locally in this installation. WhatsApp authentication data is stored on the server under a private bot session directory and is never sent to the browser. For production, move session storage to encrypted persistent storage and use HTTPS.</div></div></section>\n\n    <section id=\"about\" class=\"page\"><div class=\"panel\"><div class=\"head\"><h2>About BOTX</h2></div><div class=\"help\">BOTX is a self-hosted WhatsApp bot control panel. This build includes real account authentication, persistent bot sessions, pairing-code connection, live connection state, command handling, and bot settings. Payment/M-Pesa is intentionally not connected yet.</div></div></section>\n  </main>\n</div>\n\n<div class=\"modal\" id=\"pairModal\">\n  <div class=\"modalBox\">\n    <div class=\"modalTop\"><h2>Connect WhatsApp</h2><button class=\"close\" onclick=\"closePair()\">×</button></div>\n    <div id=\"pairStep\">\n      <div class=\"muted\">Enter the WhatsApp number you want to link.</div>\n      <div class=\"field\"><label>Phone number</label><input class=\"input\" id=\"pairPhone\" placeholder=\"254712345678\"></div>\n      <button class=\"btn primary full\" data-glow onclick=\"requestPairing()\">Generate pairing code</button>\n      <div class=\"error\" id=\"pairError\"></div>\n    </div>\n    <div id=\"codeStep\" style=\"display:none\">\n      <div class=\"muted\">Enter this code in WhatsApp → Linked Devices → Link with phone number.</div>\n      <div class=\"code\" id=\"pairCode\">--------</div>\n      <button class=\"btn full\" data-glow onclick=\"copyCode()\">Copy code</button>\n      <div class=\"help\" style=\"margin-top:15px\">Keep this window open while linking. The dashboard will update automatically when the WhatsApp connection opens.</div>\n    </div>\n  </div>\n</div>\n\n<div class=\"toast\" id=\"toast\"></div>\n\n<script>\nlet bot = null;\nlet toastTimer;\n\nfunction flash(e){\n  const b=e.currentTarget, r=b.getBoundingClientRect();\n  b.style.setProperty(\"--x\",(e.clientX-r.left)+\"px\");\n  b.style.setProperty(\"--y\",(e.clientY-r.top)+\"px\");\n  b.classList.remove(\"flash\"); void b.offsetWidth; b.classList.add(\"flash\");\n  setTimeout(()=>b.classList.remove(\"flash\"),650);\n}\ndocument.addEventListener(\"click\",e=>{const b=e.target.closest(\"[data-glow]\");if(b)flash({currentTarget:b,clientX:e.clientX,clientY:e.clientY})});\n\nfunction toast(m){const t=document.getElementById(\"toast\");t.textContent=m;t.classList.add(\"show\");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove(\"show\"),2500)}\nfunction showAuth(which){document.getElementById(\"loginForm\").style.display=which===\"login\"?\"block\":\"none\";document.getElementById(\"signupForm\").style.display=which===\"signup\"?\"block\":\"none\"}\n\nasync function api(url,opts={}){\n  const r=await fetch(url,{...opts,headers:{\"Content-Type\":\"application/json\",...(opts.headers||{})}});\n  const data=await r.json().catch(()=>({}));\n  if(!r.ok) throw new Error(data.error||\"Request failed\");\n  return data;\n}\nasync function signup(){\n  const u=document.getElementById(\"signupUser\").value.trim(),p=document.getElementById(\"signupPass\").value,p2=document.getElementById(\"signupPass2\").value;\n  document.getElementById(\"signupError\").textContent=\"\";\n  if(p!==p2){document.getElementById(\"signupError\").textContent=\"Passwords do not match.\";return}\n  try{await api(\"/api/auth/signup\",{method:\"POST\",body:JSON.stringify({username:u,password:p})});await enterApp()}catch(e){document.getElementById(\"signupError\").textContent=e.message}\n}\nasync function login(){\n  const u=document.getElementById(\"loginUser\").value.trim(),p=document.getElementById(\"loginPass\").value;\n  document.getElementById(\"loginError\").textContent=\"\";\n  try{await api(\"/api/auth/login\",{method:\"POST\",body:JSON.stringify({username:u,password:p})});await enterApp()}catch(e){document.getElementById(\"loginError\").textContent=e.message}\n}\nasync function logout(){try{await api(\"/api/auth/logout\",{method:\"POST\"})}finally{location.reload()}}\nasync function enterApp(){\n  document.getElementById(\"authScreen\").style.display=\"none\";document.getElementById(\"app\").style.display=\"flex\";await refresh();\n}\nasync function refresh(){\n  try{\n    const d=await api(\"/api/me\");bot=d.bot;\n    document.getElementById(\"sideUser\").textContent=d.user.username;\n    document.getElementById(\"avatar\").textContent=d.user.username[0].toUpperCase();\n    document.getElementById(\"botName\").textContent=bot.name;\n    document.getElementById(\"botPhone\").textContent=bot.phone?(\"+\"+bot.phone):\"Not linked\";\n    document.getElementById(\"statPrefix\").textContent=bot.prefix;\n    document.getElementById(\"statStatus\").textContent=bot.status===\"CONNECTED\"?\"Online\":bot.status===\"PAIRING\"?\"Pairing\":\"Offline\";\n    document.getElementById(\"statStatus\").className=\"value \"+(bot.status===\"CONNECTED\"?\"green\":\"orange\");\n    document.getElementById(\"statusText\").innerHTML='<span class=\"dot\"></span> '+bot.status;\n    document.getElementById(\"liveLabel\").textContent=bot.status;\n    document.getElementById(\"botPageStatus\").textContent=bot.status;\n    document.getElementById(\"botNameInput\").value=bot.name;\n    document.getElementById(\"prefixInput\").value=bot.prefix;\n  }catch(e){document.getElementById(\"authScreen\").style.display=\"flex\";document.getElementById(\"app\").style.display=\"none\"}\n}\nfunction page(id,btn){\n  document.querySelectorAll(\".page\").forEach(x=>x.classList.remove(\"active\"));document.getElementById(id).classList.add(\"active\");\n  document.querySelectorAll(\".nav button\").forEach(x=>x.classList.remove(\"active\"));if(btn)btn.classList.add(\"active\");\n  const titles={dashboard:[\"Dashboard\",\"Control your WhatsApp bot.\"],bot:[\"My Bot\",\"Connect and configure your live bot.\"],settings:[\"Settings\",\"Manage your dashboard preferences.\"],help:[\"Help\",\"Connect and operate your bot.\"],privacy:[\"Privacy\",\"Your local data and session information.\"],about:[\"About\",\"About this BOTX installation.\"]};\n  document.getElementById(\"pageTitle\").textContent=titles[id][0];document.getElementById(\"pageSub\").textContent=titles[id][1];\n  document.getElementById(\"side\").classList.remove(\"open\");\n}\nasync function saveBot(){\n  try{\n    await api(\"/api/bot\",{method:\"PATCH\",body:JSON.stringify({name:document.getElementById(\"botNameInput\").value,prefix:document.getElementById(\"prefixInput\").value})});\n    toast(\"Bot settings saved\");await refresh();\n  }catch(e){toast(e.message)}\n}\nfunction openPair(){document.getElementById(\"pairModal\").classList.add(\"show\");document.getElementById(\"pairStep\").style.display=\"block\";document.getElementById(\"codeStep\").style.display=\"none\";document.getElementById(\"pairError\").textContent=\"\"}\nfunction closePair(){document.getElementById(\"pairModal\").classList.remove(\"show\")}\nasync function requestPairing(){\n  const phone=document.getElementById(\"pairPhone\").value.trim();document.getElementById(\"pairError\").textContent=\"\";\n  try{\n    const d=await api(\"/api/bot/pair\",{method:\"POST\",body:JSON.stringify({phone})});\n    document.getElementById(\"pairCode\").textContent=d.code||\"WAITING\";\n    document.getElementById(\"pairStep\").style.display=\"none\";document.getElementById(\"codeStep\").style.display=\"block\";\n    toast(\"Pairing code generated\");poll();\n  }catch(e){document.getElementById(\"pairError\").textContent=e.message}\n}\nasync function poll(){\n  for(let i=0;i<60;i++){\n    await new Promise(r=>setTimeout(r,2000));\n    await refresh();\n    if(bot?.status===\"CONNECTED\"){toast(\"WhatsApp connected\");closePair();return}\n  }\n}\nasync function startBot(){try{await api(\"/api/bot/start\",{method:\"POST\"});toast(\"Bot started\");setTimeout(refresh,700)}catch(e){toast(e.message)}}\nasync function stopBot(){try{await api(\"/api/bot/stop\",{method:\"POST\"});toast(\"Bot stopped\");setTimeout(refresh,500)}catch(e){toast(e.message)}}\nasync function copyCode(){await navigator.clipboard.writeText(document.getElementById(\"pairCode\").textContent);toast(\"Pairing code copied\")}\nsetInterval(()=>{if(document.getElementById(\"app\").style.display!==\"none\")refresh()},5000);\n\nfor(let i=0;i<18;i++){\n  const x=document.createElement(\"i\");x.style.cssText=`position:absolute;width:${Math.random()*5+2}px;height:${Math.random()*5+2}px;border-radius:50%;left:${Math.random()*100}%;top:${Math.random()*100}%;background:${[\"#756cff\",\"#00d9ff\",\"#ff3cac\",\"#35e99a\",\"#ff9f43\",\"#fff\"][Math.floor(Math.random()*6)]};box-shadow:0 0 18px currentColor,0 0 35px currentColor;opacity:.45;`;\n  document.querySelector(\".bg\").appendChild(x);\n  x.animate([{transform:\"translate(0,0) scale(1)\",opacity:.15},{transform:`translate(${Math.random()*220-110}px,${Math.random()*220-110}px) scale(2)`,opacity:.8},{transform:`translate(${Math.random()*260-130}px,${Math.random()*260-130}px) scale(.2)`,opacity:0}],{duration:5000+Math.random()*7000,iterations:Infinity,direction:\"alternate\",easing:\"ease-in-out\"});\n}\n\n(async()=>{\n  try{await api(\"/api/me\");await enterApp()}catch{}\n})();\n</script>\n</body>\n</html>\n";

app.get("/", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

app.get("/index.html", (req, res) => {
  res.type("html").send(INDEX_HTML);
});

app.listen(PORT, () => {
  logger.info(`BOTX running at http://localhost:${PORT}`);
});
