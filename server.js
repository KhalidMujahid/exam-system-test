require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const ADMIN_COOKIE = "cca_admin_auth";
const adminSessions = new Map();
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD;
const PASS_THRESHOLD = 80;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYSTACK_SECRET_KEY = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_CURRENCY = (process.env.PAYSTACK_CURRENCY || "NGN").trim();
const APP_BASE_URL = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

app.disable("x-powered-by");

function requestOriginCandidates(req) {
  const origins = new Set();
  const hosts = new Set();
  const protos = new Set();

  if (req.get("host")) hosts.add(req.get("host"));
  const forwardedHost = req.get("x-forwarded-host");
  if (forwardedHost) hosts.add(forwardedHost.split(",")[0].trim());

  protos.add(req.protocol);
  const forwardedProto = req.get("x-forwarded-proto");
  if (forwardedProto) protos.add(forwardedProto.split(",")[0].trim());

  for (const proto of protos) {
    for (const host of hosts) {
      if (host) origins.add(`${proto}://${host}`);
    }
  }

  if (APP_BASE_URL) {
    try { origins.add(new URL(APP_BASE_URL).origin); } catch (_) { }
  }

  return origins;
}

function isSameOriginRequest(req) {
  const site = req.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  if (site === "cross-site") return false;

  const allowed = requestOriginCandidates(req);
  let sawParseableSource = false;

  for (const raw of [req.get("origin"), req.get("referer")]) {
    if (!raw || raw === "null") continue;
    try {
      sawParseableSource = true;
      if (allowed.has(new URL(raw).origin)) return true;
    } catch (_) { /* malformed header -> treat as opaque */ }
  }

  // Opaque or absent origin (e.g. embedded webviews): fall back to SameSite cookies.
  return !sawParseableSource;
}
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/paystack/webhook") return next();
  if (isSameOriginRequest(req)) return next();
  return res.status(403).send("Same-origin request required.");
});
app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 500 }));
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(cookieParser());
app.use(express.static(__dirname + "/public"));

app.get("/favicon.ico", (req, res) => {
  res.sendFile(__dirname + "/public/logo.jpeg");
});
app.get("/logo.jpeg", (req, res) => {
  res.sendFile(__dirname + "/public/logo.jpeg");
});
app.get("/htmx.min.js", (req, res) => {
  res.sendFile(require.resolve("htmx.org/dist/htmx.min.js"));
});

function toSafeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toKobo(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100);
}

app.locals.formatNaira = function (kobo) {
  const amount = toSafeInt(kobo, 0) / 100;
  return `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function baseUrlFor(req) {
  if (!APP_BASE_URL) throw new Error("APP_BASE_URL must be configured for payments.");
  return new URL(APP_BASE_URL).origin;
}

function grantAttemptAccess(req, res, attempt, durationMinutes) {
  const deadline = new Date(attempt.startedAt).getTime() + durationMinutes * 60000;
  const payload = String(deadline);
  const signature = crypto.createHmac("sha256", ATTEMPT_SECRET).update(attempt.id + ":" + payload).digest("hex");
  res.cookie("cca_attempt_" + attempt.id, payload + "." + signature, {
    httpOnly: true, sameSite: "lax", secure: req.secure || APP_BASE_URL.startsWith("https://"), maxAge: 24 * 60 * 60 * 1000
  });
}

function attemptDeadline(req) {
  const value = req.cookies["cca_attempt_" + req.params.id];
  if (typeof value !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(value)) return null;
  const [payload, signature] = value.split(".");
  const expected = crypto.createHmac("sha256", ATTEMPT_SECRET).update(req.params.id + ":" + payload).digest();
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), expected) ? Number(payload) : null;
}

let loginWindow = { until: 0, count: 0 };
function limitLogin(req, res, next) {
  const now = Date.now();
  if (now >= loginWindow.until) loginWindow = { until: now + 15 * 60000, count: 0 };
  if (++loginWindow.count > 20) {
    res.set("Retry-After", String(Math.ceil((loginWindow.until - now) / 1000)));
    return res.status(429).send("Too many login attempts. Please try again later.");
  }
  next();
}

async function paystackRequest(pathname, options = {}) {
  if (!PAYSTACK_SECRET_KEY) {
    return { ok: false, status: 0, data: { message: "Paystack is not configured." } };
  }
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { message: error.message || "Payment gateway unreachable." } };
  }
}

function generatePaymentReference() {
  const random = crypto.randomBytes(24).toString("hex");
  return `CCA-PAY-${Date.now()}-${random}`;
}

function generateFactorySamplePool(courseCode) {
  return Array.from({ length: 22 }, (_, i) => ({
    questionId: `${courseCode}-Q-${10000 + i}`,
    text: `System-generated Data Node Scenario [${courseCode} Item #${i + 1}]: Select the optimal handling criteria under core compliance metrics.`,
    optionA: "Primary baseline operations priority structure execution",
    optionB: "Secondary auxiliary processing fallback matrix configuration",
    optionC: "Tertiary perimeter isolation mechanism gamma",
    optionD: "Standard safe sandbox runtime validation loop routine",
    correctAnswer: "Primary baseline operations priority structure execution"
  }));
}

async function getSetting(key, fallback = null, db = prisma) {
  const setting = await db.setting.findUnique({ where: { key } });
  return setting ? setting.value : fallback;
}

async function setSetting(key, value) {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });
}

async function ensureSeedData() {
  const courseCount = await prisma.course.count();
  if (courseCount > 0) {
    return;
  }

  const defaultDuration = process.env.DEFAULT_EXAM_DURATION_MINUTES || "30";
  const defaultPriceKobo = toKobo(process.env.DEFAULT_COURSE_PRICE_NAIRA || "20000");
  if (!DEFAULT_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD.length < 12 || Buffer.byteLength(DEFAULT_ADMIN_PASSWORD) > 72) throw new Error("Set ADMIN_INITIAL_PASSWORD to 12 or more characters (maximum 72 UTF-8 bytes).");
  const defaultPasswordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);

  const tracks = [
    { code: "CCA-01", name: "Introduction to Cyber Crime Investigation", requiresPayment: true, priceKobo: defaultPriceKobo },
    { code: "CCA-02", name: "Digital Forensics and Evidence Preservation", requiresPayment: true, priceKobo: defaultPriceKobo },
    { code: "CCA-03", name: "Network Security and Traffic Analysis", requiresPayment: true, priceKobo: defaultPriceKobo },
    { code: "CCA-04", name: "Ethical Hacking and Penetration Testing Fundamentals", requiresPayment: true, priceKobo: defaultPriceKobo },
    { code: "CCA-05", name: "Cyber Law, Governance, and Incident Response", requiresPayment: true, priceKobo: defaultPriceKobo }
  ];

  for (const track of tracks) {
    const course = await prisma.course.create({ data: track });
    const questions = Array.from({ length: 22 }, (_, index) => ({
      questionId: `${track.code}-Q-${10000 + index}`,
      text: `System-generated Data Node Scenario [${track.code} Item #${index + 1}]: Select the optimal handling criteria under core compliance metrics.`,
      optionA: "Primary baseline operations priority structure execution",
      optionB: "Secondary auxiliary processing fallback matrix configuration",
      optionC: "Tertiary perimeter isolation mechanism gamma",
      optionD: "Standard safe sandbox runtime validation loop routine",
      correctAnswer: "Primary baseline operations priority structure execution",
      courseId: course.id
    }));
    await prisma.question.createMany({ data: questions });
  }

  await Promise.all([
    setSetting("adminPasswordHash", defaultPasswordHash),
    setSetting("examDurationMinutes", defaultDuration),
    setSetting("attemptCounter", "0")
  ]);
}

async function getAppState() {
  const [courses, attemptCounterSetting, durationSetting] = await Promise.all([
    prisma.course.findMany({
      orderBy: { code: "asc" },
      include: { _count: { select: { questions: true } } }
    }),
    getSetting("attemptCounter", "0"),
    getSetting("examDurationMinutes", "30")
  ]);

  return {
    courses,
    attemptCounter: toSafeInt(attemptCounterSetting, 0),
    examDurationMinutes: toSafeInt(durationSetting, 30)
  };
}

async function renderFullPage(res, extra = {}) {
  const state = await getAppState();
  res.render("index", {
    courses: state.courses,
    attemptCounter: state.attemptCounter,
    examDurationMinutes: state.examDurationMinutes,
    ...extra
  });
}

async function createQuizAttempt(course, name, institution, db = prisma) {
  const selectedQuestions = [...course.questions].sort(() => Math.random() - 0.5).slice(0, 20);
  const durationMinutes = toSafeInt(await getSetting("examDurationMinutes", "30", db), 30);

  const attempt = await db.attempt.create({
    data: {
      candidateName: name,
      institution,
      courseId: course.id,
      startedAt: new Date(),
      totalQuestions: selectedQuestions.length,
      status: "IN_PROGRESS",
      questionIds: selectedQuestions.map((question) => question.id)
    }
  });

  await db.attemptQuestion.createMany({
    data: selectedQuestions.map((question, index) => ({
      attemptId: attempt.id,
      questionId: question.id,
      position: index
    }))
  });

  return { attempt, questions: selectedQuestions, durationMinutes };
}

async function loadPaymentWithCourse(reference) {
  return prisma.payment.findUnique({
    where: { reference },
    include: { course: { include: { questions: true } } }
  });
}

async function resumePaymentAttempt(payment) {
  const existing = await prisma.attempt.findUnique({
    where: { id: payment.attemptId },
    include: { course: true }
  });
  if (!existing) return null;

  const links = await prisma.attemptQuestion.findMany({
    where: { attemptId: existing.id },
    orderBy: { position: "asc" },
    include: { question: true }
  });
  const durationMinutes = toSafeInt(await getSetting("examDurationMinutes", "30"), 30);

  return {
    attempt: existing,
    course: existing.course,
    questions: links.map((link) => link.question),
    durationMinutes
  };
}

async function finalizeCertificatePayment(payment) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: payment.attemptId },
    include: { course: true }
  });
  if (!attempt) return { ok: false, reason: "attempt_missing" };

  if (!attempt.certificateIssued) {
    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { certificateIssued: true, certificateIssuedAt: new Date() }
    });
  }

  if (payment.status !== "SUCCESS") {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCESS", paidAt: new Date() }
    });
  }

  const issued = await prisma.attempt.findUnique({ where: { id: attempt.id }, include: { course: true } });
  return { ok: true, attempt: issued };
}

async function finalizePayment(payment) {
  if (payment.purpose === "CERTIFICATE") {
    return finalizeCertificatePayment(payment);
  }

  if (!payment.course) return { ok: false, reason: "course_missing" };
  // Payment unlocks the course; the assessment starts only after student registration.
  await prisma.payment.updateMany({
    where: { id: payment.id, status: { not: "SUCCESS" } },
    data: { status: "SUCCESS", paidAt: new Date() }
  });
  return { ok: true };
}

function verifyPaystackSignature(req) {
  if (!PAYSTACK_SECRET_KEY || !req.rawBody) return false;
  const signature = req.headers["x-paystack-signature"];
  if (!signature) return false;
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.rawBody).digest("hex");
  const provided = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuffer);
}

function courseAccessToken(reference) {
  return crypto.createHmac("sha256", PAYSTACK_SECRET_KEY).update("course-access:" + reference).digest("hex");
}

function grantCourseAccess(req, res, payment) {
  if (!PAYSTACK_SECRET_KEY) throw new Error("Course access signing is not configured.");
  res.cookie("cca_course_" + payment.courseId, payment.reference + "." + courseAccessToken(payment.reference), {
    httpOnly: true, sameSite: "lax", secure: req.secure || APP_BASE_URL.startsWith("https://"), maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function courseAccessReference(req, courseId) {
  if (!PAYSTACK_SECRET_KEY) return null;
  const cookie = req.cookies["cca_course_" + courseId];
  if (typeof cookie !== "string") return null;
  const split = cookie.lastIndexOf(".");
  if (split < 1) return null;
  const reference = cookie.slice(0, split);
  const provided = Buffer.from(cookie.slice(split + 1));
  const expected = Buffer.from(courseAccessToken(reference));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected) ? reference : null;
}

async function canReadCourse(req, course) {
  if (!course) return false;
  if (!course.requiresPayment || isAdminAuthenticated(req)) return true;
  const reference = courseAccessReference(req, course.id);
  if (!reference) return false;
  const payment = await prisma.payment.findUnique({ where: { reference } });
  return Boolean(payment && payment.courseId === course.id && payment.purpose === "ASSESSMENT" && payment.status === "SUCCESS");
}

async function authorizedEnrollment(req) {
  const payment = await loadPaymentWithCourse(req.params.reference);
  if (!payment || payment.purpose !== "ASSESSMENT" || payment.status !== "SUCCESS" || courseAccessReference(req, payment.courseId) !== payment.reference) return null;
  return payment;
}

app.get("/certifications/:id/checkout", async (req, res, next) => {
  try {
    const course = await prisma.course.findUnique({ where: { id: req.params.id } });
    if (!course || !course.requiresPayment) return res.redirect("/certifications");
    const reference = courseAccessReference(req, course.id);
    if (reference && await canReadCourse(req, course)) return res.redirect("/courses/access/" + encodeURIComponent(reference));
    await renderFullPage(res, { courseCheckoutContent: true, checkoutCourse: course });
  } catch (err) { next(err); }
});

app.get("/courses/access/:reference", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    const payment = await authorizedEnrollment(req);
    if (!payment) return res.status(403).send("Please complete payment and return through your payment confirmation link to access this course.");
    const materials = await prisma.courseMaterial.findMany({ where: { courseId: payment.courseId }, orderBy: { createdAt: "desc" } });
    await renderFullPage(res, { courseAccessContent: true, enrollment: payment, courseMaterials: materials, registrationError: "" });
  } catch (err) { next(err); }
});

app.post("/courses/access/:reference/start", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    const payment = await authorizedEnrollment(req);
    if (!payment) return res.status(403).send("Verified course access is required.");
    const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 200) : "";
    const institution = typeof req.body.institution === "string" ? req.body.institution.trim().slice(0, 200) : "";
    if (!payment.attemptId && (!name || !institution || payment.course.questions.length < 20)) {
      const materials = await prisma.courseMaterial.findMany({ where: { courseId: payment.courseId }, orderBy: { createdAt: "desc" } });
      return renderFullPage(res, { courseAccessContent: true, enrollment: { ...payment, candidateName: name, institution }, courseMaterials: materials, registrationError: !name || !institution ? "Please enter your full name and institution." : "The assessment is not ready yet. Your payment and course access are saved; please contact the academy." });
    }
    // Serialize starts for this purchase so double-clicks and retries reuse one attempt.
    const attemptId = await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${payment.id} FOR UPDATE`;
      const current = await db.payment.findUnique({ where: { id: payment.id } });
      if (current.attemptId) return current.attemptId;
      const result = await createQuizAttempt(payment.course, name, institution, db);
      await db.payment.update({ where: { id: payment.id }, data: { candidateName: name, institution, attemptId: result.attempt.id } });
      return result.attempt.id;
    });
    const resumed = await resumePaymentAttempt({ ...payment, attemptId });
    if (!resumed) return res.status(404).send("Assessment not found.");
    grantAttemptAccess(req, res, resumed.attempt, resumed.durationMinutes);
    if (resumed.attempt.status === "COMPLETED") return renderFullPage(res, { resultContent: true, resultAttempt: resumed.attempt });
    await renderFullPage(res, { quizContent: true, quizAttempt: resumed.attempt, quizCourse: resumed.course, quizQuestions: resumed.questions, quizDurationMinutes: resumed.durationMinutes });
  } catch (err) { next(err); }
});

function isAdminAuthenticated(req) {
  const token = req.cookies[ADMIN_COOKIE];
  const expiresAt = adminSessions.get(token);
  if (expiresAt && expiresAt > Date.now()) return true;
  if (token) adminSessions.delete(token);
  return false;
}

function createAdminSession() {
  for (const [token, expiresAt] of adminSessions) if (expiresAt <= Date.now()) adminSessions.delete(token);
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
  return token;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) return res.render("partials/admin-auth", { error: "Please authenticate first." });
    return res.redirect("/admin/login");
  }
  return next();
}

app.get("/", async (req, res, next) => {
  try {
    const state = await getAppState();
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes
    });
  } catch (err) {
    next(err);
  }
});

app.get("/portal", async (req, res, next) => {
  try {
    const state = await getAppState();
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) {
      return res.render("partials/portal", {
        courses: state.courses,
        examDurationMinutes: state.examDurationMinutes
      });
    }
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      portalContent: true
    });
  } catch (err) {
    next(err);
  }
});

app.get("/home", async (req, res, next) => {
  try {
    const state = await getAppState();
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) {
      return res.render("partials/home", {
        courses: state.courses,
        attemptCounter: state.attemptCounter,
        examDurationMinutes: state.examDurationMinutes
      });
    }
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      homeContent: true
    });
  } catch (err) {
    next(err);
  }
});

app.get("/certifications", async (req, res, next) => {
  try {
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) {
      const state = await getAppState();
      return res.render("partials/certifications", { courses: state.courses });
    }
    const state = await getAppState();
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      certificationsContent: true
    });
  } catch (err) {
    next(err);
  }
});

function certificateGenerateData(extra = {}) {
  return {
    certificateResult: null,
    certificateChecksum: "",
    certificateAttempt: null,
    certificateMessage: "",
    ...extra
  };
}

app.get("/certificates/generate", async (req, res, next) => {
  try {
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) {
      return res.render("partials/certificate-generate", {
        result: null, checksum: "", attempt: null, message: ""
      });
    }
    await renderFullPage(res, {
      certificateGenerateContent: true,
      ...certificateGenerateData()
    });
  } catch (err) {
    next(err);
  }
});

app.post("/certificates/generate", async (req, res, next) => {
  try {
    const checksum = (req.body.checksum || "").trim();
    const isHtmx = req.headers["hx-request"] === "true";

    const respond = async (data) => {
      if (isHtmx) {
        return res.render("partials/certificate-generate", {
          result: data.result, checksum: data.checksum, attempt: data.attempt, message: data.message
        });
      }
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({
          certificateResult: data.result,
          certificateChecksum: data.checksum,
          certificateAttempt: data.attempt,
          certificateMessage: data.message
        })
      });
    };

    if (!checksum) {
      return respond({ result: null, checksum: "", attempt: null, message: "" });
    }

    const attempt = await prisma.attempt.findFirst({ where: { checksum }, include: { course: true } });

    if (!attempt) {
      return respond({ result: "not_found", checksum, attempt: null, message: "" });
    }

    if (!attempt.passed) {
      return respond({
        result: "failed",
        checksum,
        attempt,
        message: "This result did not meet the 80% passing threshold, so a certificate cannot be generated for it."
      });
    }

    if (attempt.certificateIssued) {
      if (isHtmx) return res.render("partials/certificate-view", { attempt });
      return renderFullPage(res, { certificateViewContent: true, certificateAttempt: attempt });
    }

    return respond({ result: "found", checksum, attempt, message: "" });
  } catch (err) {
    next(err);
  }
});

app.post("/certificates/checkout", async (req, res, next) => {
  try {
    const checksum = (req.body.checksum || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();

    const attempt = checksum
      ? await prisma.attempt.findFirst({ where: { checksum }, include: { course: true } })
      : null;

    if (!attempt) {
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({ certificateResult: "not_found", certificateChecksum: checksum })
      });
    }

    if (!attempt.passed) {
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({
          certificateResult: "failed", certificateChecksum: checksum, certificateAttempt: attempt,
          certificateMessage: "Only passed assessments can be certified."
        })
      });
    }

    if (attempt.certificateIssued) {
      return renderFullPage(res, { certificateViewContent: true, certificateAttempt: attempt });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({
          certificateResult: "found", certificateChecksum: checksum, certificateAttempt: attempt,
          certificateMessage: "A valid email address is required to process payment."
        })
      });
    }

    const feeKobo = attempt.course.certificatePriceKobo;

    if (feeKobo <= 0) {
      await prisma.attempt.update({
        where: { id: attempt.id },
        data: { certificateIssued: true, certificateIssuedAt: new Date() }
      });
      const issued = await prisma.attempt.findUnique({ where: { id: attempt.id }, include: { course: true } });
      return renderFullPage(res, { certificateViewContent: true, certificateAttempt: issued });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({
          certificateResult: "found", certificateChecksum: checksum, certificateAttempt: attempt,
          certificateMessage: "Payment is not configured yet. Please contact the administrator."
        })
      });
    }

    const reference = generatePaymentReference();
    const payment = await prisma.payment.create({
      data: {
        reference,
        purpose: "CERTIFICATE",
        candidateName: attempt.candidateName,
        institution: attempt.institution,
        email,
        courseId: attempt.courseId,
        amount: feeKobo,
        currency: PAYSTACK_CURRENCY,
        status: "PENDING",
        attemptId: attempt.id
      }
    });

    const init = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: feeKobo,
        currency: PAYSTACK_CURRENCY,
        reference,
        callback_url: `${baseUrlFor(req)}/payment/certificate/callback`,
        metadata: {
          purpose: "CERTIFICATE",
          attemptId: attempt.id,
          checksum,
          paymentId: payment.id
        }
      })
    });

    const initPayload = init.data && init.data.data;
    if (!init.ok || !init.data || init.data.status !== true || !initPayload || !initPayload.authorization_url) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({
          certificateResult: "found", certificateChecksum: checksum, certificateAttempt: attempt,
          certificateMessage: (init.data && init.data.message) || "Unable to initialize payment. Please try again."
        })
      });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { accessCode: initPayload.access_code || null, authorizationUrl: initPayload.authorization_url }
    });

    res.redirect(initPayload.authorization_url);
  } catch (err) {
    next(err);
  }
});

app.get("/payment/certificate/callback", async (req, res, next) => {
  try {
    const reference = (req.query.reference || req.query.trxref || "").trim();
    const payment = reference ? await loadPaymentWithCourse(reference) : null;

    if (!payment || payment.purpose !== "CERTIFICATE") {
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({ certificateMessage: "We could not find that certificate payment." })
      });
    }

    if (payment.status === "SUCCESS" && payment.attemptId) {
      const attempt = await prisma.attempt.findUnique({ where: { id: payment.attemptId }, include: { course: true } });
      if (attempt) return renderFullPage(res, { certificateViewContent: true, certificateAttempt: attempt });
    }

    const verification = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
    const txn = verification.data && verification.data.data;
    const verified = Boolean(
      verification.ok &&
      verification.data &&
      verification.data.status === true &&
      txn &&
      txn.status === "success" &&
      Number(txn.amount) === payment.amount &&
      txn.currency === payment.currency && txn.reference === reference
    );

    if (!verified) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: txn && txn.status === "abandoned" ? "ABANDONED" : "FAILED" }
      });
      const attempt = payment.attemptId
        ? await prisma.attempt.findUnique({ where: { id: payment.attemptId }, include: { course: true } })
        : null;
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({
          certificateResult: attempt ? "found" : "not_found",
          certificateChecksum: attempt ? attempt.checksum || "" : "",
          certificateAttempt: attempt,
          certificateMessage: (verification.data && verification.data.message) || "Your payment could not be verified."
        })
      });
    }

    const result = await finalizePayment(payment);
    if (!result.ok) {
      return renderFullPage(res, {
        certificateGenerateContent: true,
        ...certificateGenerateData({ certificateMessage: "This payment could not be linked to a certificate." })
      });
    }

    return renderFullPage(res, { certificateViewContent: true, certificateAttempt: result.attempt });
  } catch (err) {
    next(err);
  }
});

app.get("/verify", async (req, res, next) => {
  try {
    const isHtmx = req.headers["hx-request"] === "true";
    const renderData = { result: null, checksum: "" };
    if (isHtmx) {
      return res.render("partials/verify", renderData);
    }
    const state = await getAppState();
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      adminAuthenticated: isAdminAuthenticated(req),
      verifyContent: true,
      verifyResult: null,
      verifyChecksum: ""
    });
  } catch (err) {
    next(err);
  }
});

app.post("/verify", async (req, res, next) => {
  try {
    const checksum = (req.body.checksum || "").trim();
    const isHtmx = req.headers["hx-request"] === "true";
    const state = await getAppState();

    if (!checksum) {
      const renderData = { result: null, checksum: "" };
      if (isHtmx) return res.render("partials/verify", renderData);
      return res.render("index", {
        courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes,
        adminAuthenticated: isAdminAuthenticated(req), verifyContent: true, verifyResult: null, verifyChecksum: ""
      });
    }

    const attempt = await prisma.attempt.findFirst({
      where: { checksum },
      include: { course: true }
    });

    if (!attempt) {
      const renderData = { result: "not_found", checksum };
      if (isHtmx) return res.render("partials/verify", renderData);
      return res.render("index", {
        courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes,
        adminAuthenticated: isAdminAuthenticated(req), verifyContent: true, verifyResult: "not_found", verifyChecksum: checksum
      });
    }

    const renderData = { result: attempt, checksum };
    if (isHtmx) return res.render("partials/verify", renderData);
    res.render("index", {
      courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes,
      adminAuthenticated: isAdminAuthenticated(req), verifyContent: true, verifyResult: attempt, verifyChecksum: checksum
    });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/dashboard", async (req, res, next) => {
  try {
    const state = await getAppState();
    if (!isAdminAuthenticated(req)) {
      return res.redirect("/admin/login");
    }
    const selectedCourseId = req.query.courseId || (state.courses[0] && state.courses[0].id) || "";
    const selectedCourse = selectedCourseId
      ? await prisma.course.findUnique({
          where: { id: selectedCourseId },
          include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
        })
      : null;

    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      adminContent: "panel",
      adminCourses: state.courses,
      adminAttemptCounter: state.attemptCounter,
      adminExamDurationMinutes: state.examDurationMinutes,
      adminSelectedCourse: selectedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/login", async (req, res, next) => {
  try {
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) {
      return res.render("partials/admin-auth", { error: null });
    }
    const state = await getAppState();
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      adminContent: "auth",
      adminError: null
    });
  } catch (err) {
    next(err);
  }
});

app.get("/admin", async (req, res, next) => {
  try {
    const state = await getAppState();
    const isHtmx = req.headers["hx-request"] === "true";

    if (!isAdminAuthenticated(req)) {
      if (isHtmx) return res.render("partials/admin-auth", { error: null });
      return res.render("index", {
        courses: state.courses,
        attemptCounter: state.attemptCounter,
        examDurationMinutes: state.examDurationMinutes,
        adminContent: "auth",
        adminError: null
      });
    }

    const selectedCourseId = req.query.courseId || (state.courses[0] && state.courses[0].id) || "";
    const selectedCourse = selectedCourseId
      ? await prisma.course.findUnique({
          where: { id: selectedCourseId },
          include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
        })
      : null;

    if (isHtmx) {
      return res.render("partials/admin-panel", {
        courses: state.courses,
        attemptCounter: state.attemptCounter,
        examDurationMinutes: state.examDurationMinutes,
        selectedCourse
      });
    }

    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      adminContent: "panel",
      adminCourses: state.courses,
      adminAttemptCounter: state.attemptCounter,
      adminExamDurationMinutes: state.examDurationMinutes,
      adminSelectedCourse: selectedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/login", limitLogin, async (req, res, next) => {
  try {
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const storedHash = await getSetting("adminPasswordHash");
    const ok = storedHash && password !== "admin123" && Buffer.byteLength(password) <= 72 ? await bcrypt.compare(password, storedHash) : false;
    const isHtmx = req.headers["hx-request"] === "true";

    if (!ok) {
      if (isHtmx) return res.render("partials/admin-auth", { error: "Authentication failed." });
      const state = await getAppState();
      return res.render("index", {
        courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes,
        adminContent: "auth", adminError: "Authentication failed."
      });
    }

    res.cookie(ADMIN_COOKIE, createAdminSession(), { httpOnly: true, sameSite: "lax", secure: req.secure || APP_BASE_URL.startsWith("https://"), maxAge: ADMIN_SESSION_MS });

    if (isHtmx) {
      const state = await getAppState();
      const selectedCourse = state.courses[0]
        ? await prisma.course.findUnique({
            where: { id: state.courses[0].id },
            include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
          })
        : null;
      return res.render("partials/admin-panel", {
        courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes, selectedCourse
      });
    }

    res.redirect("/admin/dashboard");
  } catch (err) {
    next(err);
  }
});

app.post("/admin/logout", async (req, res) => {
  adminSessions.delete(req.cookies[ADMIN_COOKIE]);
  res.clearCookie(ADMIN_COOKIE);
  const isHtmx = req.headers["hx-request"] === "true";
  if (isHtmx) return res.render("partials/admin-auth", { error: null });
  const state = await getAppState();
  res.render("index", { courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes, adminContent: "auth", adminError: null });
});

app.post("/admin/password", requireAdmin, async (req, res, next) => {
  try {
    const nextPassword = typeof req.body.password === "string" ? req.body.password : "";
    if (nextPassword.length < 12 || Buffer.byteLength(nextPassword) > 72) {
      return res.render("partials/admin-alert", {
        message: "Password must be at least 12 characters and at most 72 UTF-8 bytes."
      });
    }

    const hash = await bcrypt.hash(nextPassword, 10);
    await setSetting("adminPasswordHash", hash);
    adminSessions.clear();

    res.render("partials/admin-alert", {
      message: "Password updated. Please sign in again with your new password."
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/duration", requireAdmin, async (req, res, next) => {
  try {
    const minutes = toSafeInt(req.body.minutes, 30);
    if (minutes < 1 || minutes > 180) {
      return res.render("partials/admin-alert", {
        message: "Duration must be between 1 and 180 minutes."
      });
    }

    await setSetting("examDurationMinutes", String(minutes));
    const state = await getAppState();
    res.render("partials/admin-stats", state);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/attempts/reset", requireAdmin, async (req, res, next) => {
  try {
    await setSetting("attemptCounter", "0");
    const state = await getAppState();
    res.render("partials/admin-stats", state);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/courses", requireAdmin, async (req, res, next) => {
  try {
    const originalCode = (req.body.originalCode || "").trim();
    const code = (req.body.code || "").trim();
    const name = (req.body.name || "").trim();
    if (!code || !name) {
      return res.render("partials/admin-alert", { message: "Code and name are required." });
    }

    const requiresPayment = ["on", "1", "true", "yes"].includes(
      String(req.body.requiresPayment || "").trim().toLowerCase()
    );

    const rawPrice = (req.body.priceNaira || "").toString().trim();
    let priceKobo = rawPrice === "" ? 0 : toKobo(rawPrice);
    if (rawPrice !== "" && (Number.isNaN(Number.parseFloat(rawPrice)) || Number.parseFloat(rawPrice) < 0)) {
      return res.render("partials/admin-alert", { message: "Price must be a valid non-negative amount." });
    }

    if (requiresPayment && priceKobo <= 0) {
      return res.render("partials/admin-alert", {
        message: "A paid assessment needs a fee greater than 0. Set a price or uncheck 'Requires payment'."
      });
    }

    if (!requiresPayment) {
      priceKobo = 0;
    }

    const rawCertPrice = (req.body.certificatePriceNaira || "").toString().trim();
    const certificatePriceKobo = rawCertPrice === "" ? 0 : toKobo(rawCertPrice);
    if (rawCertPrice !== "" && (Number.isNaN(Number.parseFloat(rawCertPrice)) || Number.parseFloat(rawCertPrice) < 0)) {
      return res.render("partials/admin-alert", { message: "Certificate price must be a valid non-negative amount." });
    }

    if (originalCode) {
      const course = await prisma.course.findUnique({ where: { code: originalCode } });
      if (!course) {
        return res.render("partials/admin-alert", { message: "Course not found." });
      }

      try {
        await prisma.course.update({
          where: { id: course.id },
          data: { code, name, requiresPayment, priceKobo, certificatePriceKobo }
        });
      } catch (error) {
        if (error.code === "P2002") {
          return res.render("partials/admin-alert", { message: "That course code already exists." });
        }
        throw error;
      }
    } else {
      try {
        await prisma.course.create({ data: { code, name, requiresPayment, priceKobo, certificatePriceKobo } });
      } catch (error) {
        if (error.code === "P2002") {
          return res.render("partials/admin-alert", { message: "That course code already exists." });
        }
        throw error;
      }
    }

    const state = await getAppState();
    const selectedCourse = await prisma.course.findUnique({
      where: { code },
      include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
    });

    res.render("partials/admin-panel", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      selectedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/questions", requireAdmin, async (req, res, next) => {
  try {
    const courseId = (req.body.courseId || "").trim();
    const payloadRaw = (req.body.payload || "").trim();

    if (!courseId) {
      return res.render("partials/admin-alert", { message: "Select a course before saving questions." });
    }

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: { questions: { orderBy: { createdAt: "asc" } } }
    });

    if (!course) {
      return res.render("partials/admin-alert", { message: "Course not found." });
    }

    let parsed;
    try {
      parsed = JSON.parse(payloadRaw);
    } catch {
      return res.render("partials/admin-alert", { message: "Question payload must be valid JSON." });
    }

    if (!Array.isArray(parsed)) {
      return res.render("partials/admin-alert", { message: "Question payload must be an array." });
    }

    for (const [index, item] of parsed.entries()) {
      for (const field of ["Question_ID", "Question_Text", "Option_A", "Option_B", "Option_C", "Option_D", "Correct_Answer"]) {
        if (!item[field] || typeof item[field] !== "string") {
          return res.render("partials/admin-alert", { message: `Question ${index + 1} is missing ${field}.` });
        }
      }
    }

    await prisma.$transaction([
      prisma.question.deleteMany({ where: { courseId: course.id } }),
      prisma.question.createMany({
        data: parsed.map((item) => ({
          questionId: item.Question_ID.trim(),
          text: item.Question_Text.trim(),
          optionA: item.Option_A.trim(),
          optionB: item.Option_B.trim(),
          optionC: item.Option_C.trim(),
          optionD: item.Option_D.trim(),
          correctAnswer: item.Correct_Answer.trim(),
          courseId: course.id
        }))
      })
    ]);

    const updatedCourse = await prisma.course.findUnique({
      where: { id: course.id },
      include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
    });
    const state = await getAppState();

    res.render("partials/admin-panel", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      selectedCourse: updatedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/questions/reset", requireAdmin, async (req, res, next) => {
  try {
    const courseId = (req.body.courseId || "").trim();
    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course) {
      return res.render("partials/admin-alert", { message: "Course not found." });
    }

    const samplePool = generateFactorySamplePool(course.code).map((item) => ({
      questionId: item.questionId,
      text: item.text,
      optionA: item.optionA,
      optionB: item.optionB,
      optionC: item.optionC,
      optionD: item.optionD,
      correctAnswer: item.correctAnswer,
      courseId: course.id
    }));

    await prisma.$transaction([
      prisma.question.deleteMany({ where: { courseId: course.id } }),
      prisma.question.createMany({ data: samplePool })
    ]);

    const updatedCourse = await prisma.course.findUnique({
      where: { id: course.id },
      include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
    });
    const state = await getAppState();

    res.render("partials/admin-panel", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      selectedCourse: updatedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.post("/checkout", async (req, res, next) => {
  try {
    const courseId = (req.body.courseId || "").trim();
    const name = (req.body.name || "").trim();
    const institution = (req.body.institution || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();

    if (!courseId) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: "Please select a course."
      });
    }

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: { questions: true }
    });

    if (!course) {
      return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Selected course was not found." });
    }

    if (course.questions.length < 20) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: `This track needs at least 20 questions. It currently has ${course.questions.length}.`
      });
    }

    if (course.requiresPayment && course.priceKobo <= 0) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: "This paid assessment does not have a fee configured yet. Please contact the administrator."
      });
    }

    if (!course.requiresPayment) {
      if (!name || !institution) return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Your full name and institution are required." });
      const { attempt, questions, durationMinutes } = await createQuizAttempt(course, name, institution);
      grantAttemptAccess(req, res, attempt, durationMinutes);
      return renderFullPage(res, {
        quizContent: true,
        quizAttempt: attempt,
        quizCourse: course,
        quizQuestions: questions,
        quizDurationMinutes: durationMinutes
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: "A valid email address is required to process payment."
      });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: "Payment is not configured yet. Please contact the administrator."
      });
    }

    const reference = generatePaymentReference();
    const payment = await prisma.payment.create({
      data: {
        reference,
        candidateName: name,
        institution,
        email,
        courseId: course.id,
        amount: course.priceKobo,
        currency: PAYSTACK_CURRENCY,
        status: "PENDING"
      }
    });

    const init = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: course.priceKobo,
        currency: PAYSTACK_CURRENCY,
        reference,
        callback_url: `${baseUrlFor(req)}/payment/callback`,
        metadata: {
          candidateName: name,
          institution,
          courseId: course.id,
          courseCode: course.code,
          paymentId: payment.id
        }
      })
    });

    const initPayload = init.data && init.data.data;
    if (!init.ok || !init.data || init.data.status !== true || !initPayload || !initPayload.authorization_url) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: (init.data && init.data.message) || "Unable to initialize payment. Please try again."
      });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        accessCode: initPayload.access_code || null,
        authorizationUrl: initPayload.authorization_url
      }
    });

    res.redirect(initPayload.authorization_url);
  } catch (err) {
    next(err);
  }
});

app.get("/payment/callback", async (req, res, next) => {
  try {
    const reference = typeof (req.query.reference || req.query.trxref) === "string" ? (req.query.reference || req.query.trxref).trim() : "";
    const payment = reference ? await loadPaymentWithCourse(reference) : null;
    if (!payment || payment.purpose !== "ASSESSMENT") return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Assessment payment was not found." });
    if (payment.status !== "SUCCESS") {
      const verification = await paystackRequest('/transaction/verify/' + encodeURIComponent(reference), { method: "GET" });
      const txn = verification.data && verification.data.data;
      const verified = verification.ok && verification.data.status === true && txn && txn.status === "success" && Number(txn.amount) === payment.amount && txn.currency === payment.currency && txn.reference === reference;
      if (!verified) return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Payment has not been confirmed. No assessment has started. You can retry this page after completing payment." });
      const result = await finalizePayment(payment);
      if (!result.ok) return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Your payment could not be linked to a course. Please contact the academy." });
    }
    grantCourseAccess(req, res, payment);
    res.redirect('/courses/access/' + encodeURIComponent(reference));
  } catch (err) { next(err); }
});

app.post("/paystack/webhook", async (req, res) => {
  if (!verifyPaystackSignature(req)) {
    return res.status(401).json({ status: "invalid signature" });
  }

  const event = req.body || {};

  try {
    if (event.event === "charge.success" && event.data && event.data.reference) {
      const reference = String(event.data.reference).trim();
      const payment = await loadPaymentWithCourse(reference);

      if (!payment) {
        console.warn(`Paystack webhook: no payment record for reference ${reference}.`);
      } else {
        const succeeded = String(event.data.status || "").toLowerCase() === "success";
        const amountMatches = Number(event.data.amount) === payment.amount;
        const currencyMatches = String(event.data.currency || "").toUpperCase() === payment.currency.toUpperCase();

        if (succeeded && amountMatches && currencyMatches) {
          const result = await finalizePayment(payment);
          if (!result.ok) {
            console.error(`Paystack webhook: payment ${reference} could not be finalised (${result.reason}).`);
          }
        } else {
          console.warn(`Paystack webhook: charge.success for ${reference} failed validation (status/amount/currency).`);
        }
      }
    }
  } catch (error) {
    console.error("Paystack webhook error:", error);
  }

  res.sendStatus(200);
});

app.get("/materials", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const courseId = typeof req.query.courseId === "string" ? req.query.courseId : "";
    const page = Math.max(1, Math.min(10000, toSafeInt(req.query.page, 1)));
    const where = {
      ...(courseId ? { courseId } : {}),
      ...(q ? { OR: [
        { title: { contains: q, mode: "insensitive" } },
        { course: { name: { contains: q, mode: "insensitive" } } },
        { course: { code: { contains: q, mode: "insensitive" } } }
      ] } : {})
    };
    const [courses, materials, total] = await Promise.all([
      prisma.course.findMany({ orderBy: { name: "asc" } }),
      prisma.courseMaterial.findMany({ where, include: { course: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * 24, take: 24 }),
      prisma.courseMaterial.count({ where })
    ]);
    const library = { courses, materials, total, q, courseId, page };
    if (req.headers["hx-request"] === "true") return res.render("partials/materials", { library });
    await renderFullPage(res, { materialsContent: true, library });
  } catch (err) { next(err); }
});

app.get("/materials/download/:id", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    const material = await prisma.courseMaterial.findUnique({ where: { id: req.params.id }, include: { course: true } });
    if (!material) return res.status(404).send("Material not found.");
    const url = new URL(material.url);
    if (!["https:", "http:"].includes(url.protocol)) return res.status(400).send("Invalid material link.");
    if (url.hostname === "drive.google.com") {
      const fileId = url.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1] || url.searchParams.get("id");
      if (fileId && /^[\w-]+$/.test(fileId)) return res.redirect(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`);
    }
    return res.redirect(url.href);
  } catch (err) { next(err); }
});

app.get("/materials/:courseId", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    const course = await prisma.course.findUnique({ where: { id: req.params.courseId } });
    if (!course) return res.status(404).json({ error: "Course not found." });
    const materials = await prisma.courseMaterial.findMany({
      where: { courseId: req.params.courseId },
      orderBy: { createdAt: "desc" }
    });
    res.json(materials);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/materials/update/:id", requireAdmin, async (req, res, next) => {
  try {
    const existing = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).send("Material not found.");
    const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 300) : "";
    const url = typeof req.body.linkUrl === "string" ? req.body.linkUrl.trim() : "";
    const courseId = typeof req.body.courseId === "string" ? req.body.courseId : "";
    let validUrl = false;
    try { const parsed = new URL(url); validUrl = ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch {}
    const course = courseId ? await prisma.course.findUnique({ where: { id: courseId } }) : null;
    const state = await getAppState();
    if (!title || !validUrl || !course) return res.render("partials/material-edit", {
      material: { ...existing, title, url, courseId }, courses: state.courses,
      error: !title ? "Enter a material title." : !validUrl ? "Enter a valid http or https link without embedded login details." : "Choose an existing course."
    });
    await prisma.courseMaterial.update({ where: { id: existing.id }, data: { title, url, courseId, filename: title } });
    const selectedCourse = await prisma.course.findUnique({ where: { id: courseId }, include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } } });
    res.set("HX-Retarget", "#main");
    res.set("HX-Reswap", "innerHTML");
    res.render("partials/admin-panel", { ...state, selectedCourse, materialNotice: "Material updated." });
  } catch (err) { next(err); }
});

app.post("/admin/materials", requireAdmin, async (req, res, next) => {
  try {
    const courseId = (req.body.courseId || "").trim();
    const title = (req.body.title || "").trim();
    const linkUrl = (req.body.linkUrl || "").trim();

    if (!courseId || !title || !linkUrl) {
      return res.render("partials/admin-alert", { message: "Course, title, and a material link are required." });
    }
    if (!/^https?:\/\//i.test(linkUrl)) {
      return res.render("partials/admin-alert", { message: "The link must be a valid URL starting with http:// or https://." });
    }

    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course) {
      return res.render("partials/admin-alert", { message: "Course not found." });
    }

    await prisma.courseMaterial.create({
      data: {
        courseId,
        title,
        url: linkUrl,
        filename: title,
        mimeType: "link"
      }
    });

    const updatedCourse = await prisma.course.findUnique({
      where: { id: courseId },
      include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
    });
    const state = await getAppState();
    res.render("partials/admin-panel", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      selectedCourse: updatedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.get("/materials/open/:id", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    const material = await prisma.courseMaterial.findUnique({ where: { id: req.params.id }, include: { course: true } });
    if (!material) return res.status(404).send("Material not found.");
    const url = new URL(material.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return res.status(400).send("Invalid material link.");
    res.redirect(url.href);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/materials/delete/:id", requireAdmin, async (req, res, next) => {
  try {
    const material = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
    if (!material) return res.render("partials/admin-alert", { message: "Material not found." });
    const courseId = material.courseId;

    await prisma.courseMaterial.delete({ where: { id: material.id } });
    const updatedCourse = await prisma.course.findUnique({
      where: { id: courseId },
      include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
    });
    const state = await getAppState();
    res.render("partials/admin-panel", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      selectedCourse: updatedCourse
    });
  } catch (err) {
    next(err);
  }
});

app.post("/attempts/:id/submit", async (req, res, next) => {
  try {
    const deadline = attemptDeadline(req);
    if (!deadline) return res.status(403).send("Assessment access required.");
    const attemptId = req.params.id;
    const result = await prisma.$transaction(async (db) => {
    await db.$queryRaw`SELECT "id" FROM "Attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
    const attempt = await db.attempt.findUnique({
      where: { id: attemptId },
      include: {
        course: true,
        questionLinks: {
          include: { question: true },
          orderBy: { position: "asc" }
        }
      }
    });

    if (!attempt) {
      return null;
    }

    const alreadyFinished = attempt.status === "COMPLETED";
    if (alreadyFinished) {
      return attempt;
    }

    const answers = req.body.answers || {};
    const flatAnswers = Object.fromEntries(
      Object.entries(req.body)
        .filter(([key]) => key.startsWith("answers["))
        .map(([key, value]) => {
          const match = key.match(/^answers\[(.+)\]$/);
          return match ? [match[1], value] : null;
        })
        .filter(Boolean)
    );
    let rawScore = 0;
    const responses = attempt.questionLinks.map((link) => {
      const submitted = answers[String(link.questionId)] || flatAnswers[String(link.questionId)];
      // A short grace period permits the browser timer's automatic submission.
      const selected = Date.now() <= deadline + 10000 && typeof submitted === "string" ? submitted : null;
      const correct = link.question.correctAnswer;
      const isCorrect = selected === correct;
      if (isCorrect) rawScore += 1;
      return {
        questionId: link.questionId,
        selectedAnswer: selected,
        isCorrect
      };
    });

    const percentage = attempt.totalQuestions > 0 ? (rawScore / attempt.totalQuestions) * 100 : 0;
    const passed = percentage >= PASS_THRESHOLD;
    const endedAt = new Date();

    const updated = await db.attempt.update({
      where: { id: attempt.id },
      data: {
        status: "COMPLETED",
        endedAt,
        rawScore,
        percentage,
        passed,
        checksum: "CCA-SYS-TRK-" + crypto.randomBytes(24).toString("hex").toUpperCase(),
        responses: {
          createMany: {
            data: responses
          }
        }
      },
      include: {
        course: true,
        responses: true
      }
    });

    await db.$executeRaw`INSERT INTO "Setting" ("key", "value", "createdAt", "updatedAt") VALUES ('attemptCounter', '1', NOW(), NOW()) ON CONFLICT ("key") DO UPDATE SET "value" = (("Setting"."value")::integer + 1)::text, "updatedAt" = NOW()`;
    return updated;
    });
    if (!result) return res.status(404).render("partials/quiz-error", { message: "Attempt not found." });
    res.render("partials/result-view", { attempt: result });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Server error");
});

async function main() {
  await prisma.$connect();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
