import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/isc-hour-tracker";
const JWT_SECRET = process.env.JWT_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "ISC Hour Tracker <no-reply@fnaf.sy-baubau.ch>";
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Create a .env file (see .env.example).");
  process.exit(1);
}

/* ---------- database ---------- */
await mongoose.connect(MONGO_URL);
console.log("MongoDB connected");

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    rate: { type: Number, default: 28 },
    weeks: { type: mongoose.Schema.Types.Mixed, default: {} },
    resetTokenHash: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);
const User = mongoose.model("User", userSchema);

/* ---------- app ---------- */
const app = express();
app.set("trust proxy", 1); // behind nginx
app.use(express.json({ limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later." },
});

const sign = (user) => jwt.sign({ uid: user._id.toString() }, JWT_SECRET, { expiresIn: "30d" });

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.uid = jwt.verify(token, JWT_SECRET).uid;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired, please log in again" });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- auth routes ---------- */
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!EMAIL_RE.test(email || "")) return res.status(400).json({ error: "Invalid email address" });
  if (!password || password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ email, passwordHash });
  res.json({ token: sign(user), email: user.email });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: (email || "").toLowerCase().trim() });
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash)))
    return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(user), email: user.email });
});

/* ---------- password reset via Resend ---------- */
async function sendResetEmail(to, link) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const petals = ["#6EC5E9", "#B08BC9", "#F096B4", "#8FD4C1", "#E8D96E"]
    .map((c) => `<td style="width:14px;height:14px;border-radius:50%;background:${c};"></td><td style="width:6px;"></td>`)
    .join("");
  const html = `
  <div style="background:#FDFDFB;padding:32px 16px;font-family:'Nunito','Segoe UI',system-ui,sans-serif;color:#1D1D1B;">
    <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1.5px solid #E4E4DE;border-radius:24px;padding:32px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>${petals}</tr></table>
      <h1 style="font-size:20px;margin:18px 0 4px;font-weight:800;">ISC hour tracker</h1>
      <p style="color:#8A8A86;font-size:12px;margin:0 0 20px;font-weight:600;">Informatique et systèmes de communication</p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 20px;">Someone asked to reset the password for this account. Click the button below to choose a new one. This link is valid for <strong>1 hour</strong>.</p>
      <a href="${link}" style="display:inline-block;background:#E5137D;color:#ffffff;font-weight:800;font-size:14px;padding:12px 22px;border-radius:999px;text-decoration:none;">Reset password</a>
      <p style="color:#8A8A86;font-size:12px;line-height:1.6;margin:20px 0 0;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    </div>
  </div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: "Reset your ISC Hour Tracker password", html }),
  });
  if (!res.ok) throw new Error(`Resend API error ${res.status}: ${await res.text()}`);
}

app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!EMAIL_RE.test(email || "")) return res.status(400).json({ error: "Invalid email address" });
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    try {
      await sendResetEmail(user.email, `${APP_URL}/reset-password?token=${token}`);
    } catch (err) {
      console.error("Reset email failed:", err.message);
      return res.status(500).json({ error: "Could not send the email, try again later" });
    }
  }
  // same answer whether or not the account exists
  res.json({ ok: true });
});

app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || typeof token !== "string") return res.status(400).json({ error: "Invalid reset link" });
  if (!password || password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const user = await User.findOne({ resetTokenHash: tokenHash, resetTokenExpires: { $gt: new Date() } });
  if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired" });
  user.passwordHash = await bcrypt.hash(password, 12);
  user.resetTokenHash = null;
  user.resetTokenExpires = null;
  await user.save();
  res.json({ token: sign(user), email: user.email });
});

/* ---------- data routes ---------- */
app.get("/api/me", auth, async (req, res) => {
  const user = await User.findById(req.uid).lean();
  if (!user) return res.status(401).json({ error: "Account not found" });
  res.json({ email: user.email, rate: user.rate, weeks: user.weeks || {} });
});

app.put("/api/data", auth, async (req, res) => {
  const { rate, weeks } = req.body || {};
  const update = {};
  if (typeof rate === "number" && rate >= 0 && rate <= 10000) update.rate = rate;
  if (weeks && typeof weeks === "object" && !Array.isArray(weeks)) {
    // basic shape validation: { "YYYY-MM-DD": { days: [{h, note} x7] } }
    for (const [k, w] of Object.entries(weeks)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !w || !Array.isArray(w.days) || w.days.length !== 7)
        return res.status(400).json({ error: "Malformed week data" });
      for (const d of w.days) {
        if (typeof d.h !== "number" || d.h < 0 || d.h > 24 || typeof d.note !== "string" || d.note.length > 500)
          return res.status(400).json({ error: "Malformed day entry" });
      }
    }
    update.weeks = weeks;
  }
  await User.findByIdAndUpdate(req.uid, { $set: update });
  res.json({ ok: true });
});

app.post("/api/auth/change-password", auth, authLimiter, async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  const user = await User.findById(req.uid);
  if (!user || !(await bcrypt.compare(current || "", user.passwordHash)))
    return res.status(401).json({ error: "Current password is wrong" });
  user.passwordHash = await bcrypt.hash(next, 12);
  await user.save();
  res.json({ ok: true });
});

/* ---------- static frontend ---------- */
const dist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => console.log(`ISC Hour Tracker listening on :${PORT}`));
