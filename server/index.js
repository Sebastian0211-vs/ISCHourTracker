import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/isc-hour-tracker";
const JWT_SECRET = process.env.JWT_SECRET;

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
