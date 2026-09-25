require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const ADMIN_COOKIE = "cca_admin_auth";
const DEFAULT_ADMIN_PASSWORD = "admin123";
const PASS_THRESHOLD = 80;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYSTACK_SECRET_KEY = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_CURRENCY = (process.env.PAYSTACK_CURRENCY || "NGN").trim();
const APP_BASE_URL = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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
  return APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
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
  const random = Math.random().toString(36).slice(2, 10).toUpperCase();
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

async function getSetting(key, fallback = null) {
  const setting = await prisma.setting.findUnique({ where: { key } });
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

async function createQuizAttempt(course, name, institution) {
  const selectedQuestions = [...course.questions].sort(() => Math.random() - 0.5).slice(0, 20);
  const durationMinutes = toSafeInt(await getSetting("examDurationMinutes", "30"), 30);

  const attempt = await prisma.attempt.create({
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

  await prisma.attemptQuestion.createMany({
    data: selectedQuestions.map((question, index) => ({
      attemptId: attempt.id,
      questionId: question.id,
      position: index
    }))
  });

  return { attempt, questions: selectedQuestions, durationMinutes };
}

function isAdminAuthenticated(req) {
  return req.cookies[ADMIN_COOKIE] === "1";
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

const COMING_SOON = {
  title: "Generate Certificate",
  message: "Certificate generation is coming soon. Certificates will be issued automatically once you complete and pass an assessment."
};

app.get("/certificates/generate", async (req, res, next) => {
  try {
    const isHtmx = req.headers["hx-request"] === "true";
    if (isHtmx) {
      return res.render("partials/coming-soon", COMING_SOON);
    }
    await renderFullPage(res, {
      comingSoonContent: true,
      comingSoonTitle: COMING_SOON.title,
      comingSoonMessage: COMING_SOON.message
    });
  } catch (err) {
    next(err);
  }
});

app.post("/certificates/generate", async (req, res, next) => {
  try {
    res.render("partials/coming-soon", COMING_SOON);
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

app.post("/admin/login", async (req, res, next) => {
  try {
    const password = (req.body.password || "").trim();
    const storedHash = await getSetting("adminPasswordHash");
    const ok = storedHash ? await bcrypt.compare(password, storedHash) : false;
    const isHtmx = req.headers["hx-request"] === "true";

    if (!ok) {
      if (isHtmx) return res.render("partials/admin-auth", { error: "Authentication failed." });
      const state = await getAppState();
      return res.render("index", {
        courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes,
        adminContent: "auth", adminError: "Authentication failed."
      });
    }

    res.cookie(ADMIN_COOKIE, "1", { httpOnly: true, sameSite: "lax" });

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
  res.clearCookie(ADMIN_COOKIE);
  const isHtmx = req.headers["hx-request"] === "true";
  if (isHtmx) return res.render("partials/admin-auth", { error: null });
  const state = await getAppState();
  res.render("index", { courses: state.courses, attemptCounter: state.attemptCounter, examDurationMinutes: state.examDurationMinutes, adminContent: "auth", adminError: null });
});

app.post("/admin/password", requireAdmin, async (req, res, next) => {
  try {
    const nextPassword = (req.body.password || "").trim();
    if (nextPassword.length < 4) {
      return res.render("partials/admin-alert", {
        message: "Password must be at least 4 characters long."
      });
    }

    const hash = await bcrypt.hash(nextPassword, 10);
    await setSetting("adminPasswordHash", hash);

    res.render("partials/admin-alert", {
      message: "Administrative password updated."
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

    if (originalCode) {
      const course = await prisma.course.findUnique({ where: { code: originalCode } });
      if (!course) {
        return res.render("partials/admin-alert", { message: "Course not found." });
      }

      try {
        await prisma.course.update({
          where: { id: course.id },
          data: { code, name, requiresPayment, priceKobo }
        });
      } catch (error) {
        if (error.code === "P2002") {
          return res.render("partials/admin-alert", { message: "That course code already exists." });
        }
        throw error;
      }
    } else {
      try {
        await prisma.course.create({ data: { code, name, requiresPayment, priceKobo } });
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

    if (!name || !institution || !courseId) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: "Name, institution, and track are required."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: "A valid email address is required to process payment."
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
      const { attempt, questions, durationMinutes } = await createQuizAttempt(course, name, institution);
      return renderFullPage(res, {
        quizContent: true,
        quizAttempt: attempt,
        quizCourse: course,
        quizQuestions: questions,
        quizDurationMinutes: durationMinutes
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
        status: "PENDING",
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
    const reference = (req.query.reference || req.query.trxref || "").trim();
    if (!reference) {
      return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Missing payment reference." });
    }

    const payment = await prisma.payment.findUnique({
      where: { reference },
      include: { course: { include: { questions: true } } }
    });

    if (!payment) {
      return renderFullPage(res, { quizErrorContent: true, quizErrorMessage: "Payment record was not found." });
    }

    if (payment.status === "SUCCESS" && payment.attemptId) {
      const existing = await prisma.attempt.findUnique({ where: { id: payment.attemptId }, include: { course: true } });
      if (existing) {
        const links = await prisma.attemptQuestion.findMany({
          where: { attemptId: existing.id },
          orderBy: { position: "asc" },
          include: { question: true }
        });
        const durationMinutes = toSafeInt(await getSetting("examDurationMinutes", "30"), 30);
        return renderFullPage(res, {
          quizContent: true,
          quizAttempt: existing,
          quizCourse: existing.course,
          quizQuestions: links.map((link) => link.question),
          quizDurationMinutes: durationMinutes
        });
      }
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
      txn.currency === payment.currency
    );

    if (!verified) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: txn && txn.status === "abandoned" ? "ABANDONED" : "FAILED" }
      });
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: (verification.data && verification.data.message) || "Your payment could not be verified. No assessment was started."
      });
    }

    const course = payment.course;
    if (course.questions.length < 20) {
      return renderFullPage(res, {
        quizErrorContent: true,
        quizErrorMessage: `This track needs at least 20 questions. It currently has ${course.questions.length}.`
      });
    }

    const { attempt, questions, durationMinutes } = await createQuizAttempt(course, payment.candidateName, payment.institution);

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCESS", paidAt: new Date(), attemptId: attempt.id }
    });

    await renderFullPage(res, {
      quizContent: true,
      quizAttempt: attempt,
      quizCourse: course,
      quizQuestions: questions,
      quizDurationMinutes: durationMinutes
    });
  } catch (err) {
    next(err);
  }
});

app.get("/materials/:courseId", async (req, res, next) => {
  try {
    const materials = await prisma.courseMaterial.findMany({
      where: { courseId: req.params.courseId },
      orderBy: { createdAt: "desc" }
    });
    res.json(materials);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/materials/upload", requireAdmin, upload.single("file"), async (req, res, next) => {
  try {
    const courseId = (req.body.courseId || "").trim();
    if (!courseId || !req.file) {
      return res.render("partials/admin-alert", { message: "Course and file are required." });
    }
    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course) {
      return res.render("partials/admin-alert", { message: "Course not found." });
    }

    const imageMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
    const isImage = imageMimeTypes.includes(req.file.mimetype);
    const resourceType = isImage ? "image" : "raw";

    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: "cca_materials",
          public_id: `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
          access_mode: "public"
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    await prisma.courseMaterial.create({
      data: {
        courseId,
        title: req.body.title || req.file.originalname,
        filename: req.file.originalname,
        cloudinaryId: result.public_id,
        cloudinaryType: resourceType,
        url: result.secure_url,
        filesize: req.file.size,
        mimeType: req.file.mimetype
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

app.get("/materials/download/:id", async (req, res, next) => {
  try {
    const material = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
    if (!material) return res.status(404).send("Material not found.");
    const type = material.cloudinaryType || "raw";
    const downloadUrl = cloudinary.url(material.cloudinaryId, {
      resource_type: type,
      secure: true,
      type: "upload",
      flags: "attachment",
      attachment_name: material.filename
    });
    res.redirect(downloadUrl);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/materials/delete/:id", requireAdmin, async (req, res, next) => {
  try {
    const material = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
    if (!material) return res.render("partials/admin-alert", { message: "Material not found." });
    const courseId = material.courseId;

    try {
      await cloudinary.uploader.destroy(material.cloudinaryId, { resource_type: material.cloudinaryType || "raw" });
    } catch (_) {}

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
    const attemptId = req.params.id;
    const attempt = await prisma.attempt.findUnique({
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
      return res.render("partials/quiz-error", { message: "Attempt not found." });
    }

    const alreadyFinished = attempt.status === "COMPLETED";
    if (alreadyFinished) {
      return res.render("partials/result-view", { attempt });
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
      const selected = answers[String(link.questionId)] || flatAnswers[String(link.questionId)] || null;
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

    const updated = await prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        status: "COMPLETED",
        endedAt,
        rawScore,
        percentage,
        passed,
        checksum: `CCA-SYS-TRK-${Buffer.from(`${attempt.candidateName}|${rawScore}|${endedAt.getTime()}`)
          .toString("base64")
          .substring(0, 24)
          .toUpperCase()}`,
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

    const counter = toSafeInt(await getSetting("attemptCounter", "0"), 0) + 1;
    await setSetting("attemptCounter", String(counter));

    res.render("partials/result-view", { attempt: updated });
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