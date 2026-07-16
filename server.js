require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const ADMIN_COOKIE = "cca_admin_auth";
const DEFAULT_ADMIN_PASSWORD = "admin123";
const PASS_THRESHOLD = 80;
const UPLOADS_DIR = __dirname + "/uploads/materials";

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

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
  const defaultPasswordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);

  const tracks = [
    { code: "CCA-01", name: "Introduction to Cyber Crime Investigation" },
    { code: "CCA-02", name: "Digital Forensics and Evidence Preservation" },
    { code: "CCA-03", name: "Network Security and Traffic Analysis" },
    { code: "CCA-04", name: "Ethical Hacking and Penetration Testing Fundamentals" },
    { code: "CCA-05", name: "Cyber Law, Governance, and Incident Response" }
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

function isAdminAuthenticated(req) {
  return req.cookies[ADMIN_COOKIE] === "1";
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.render("partials/admin-auth", { error: "Please authenticate first." });
  }
  return next();
}

app.get("/", async (req, res, next) => {
  try {
    const state = await getAppState();
    res.render("index", {
      courses: state.courses,
      attemptCounter: state.attemptCounter,
      examDurationMinutes: state.examDurationMinutes,
      adminAuthenticated: isAdminAuthenticated(req)
    });
  } catch (err) {
    next(err);
  }
});

app.get("/portal", async (req, res, next) => {
  try {
    const state = await getAppState();
    res.render("partials/portal", {
      courses: state.courses,
      examDurationMinutes: state.examDurationMinutes
    });
  } catch (err) {
    next(err);
  }
});

app.get("/admin", async (req, res, next) => {
  try {
    const state = await getAppState();
    if (!isAdminAuthenticated(req)) {
      return res.render("partials/admin-auth", { error: null });
    }

    const selectedCourseId = req.query.courseId || (state.courses[0] && state.courses[0].id) || "";
    const selectedCourse = selectedCourseId
      ? await prisma.course.findUnique({
          where: { id: selectedCourseId },
          include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
        })
      : null;

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

app.post("/admin/login", async (req, res, next) => {
  try {
    const password = (req.body.password || "").trim();
    const storedHash = await getSetting("adminPasswordHash");
    const ok = storedHash ? await bcrypt.compare(password, storedHash) : false;

    if (!ok) {
      return res.render("partials/admin-auth", { error: "Authentication failed." });
    }

    res.cookie(ADMIN_COOKIE, "1", { httpOnly: true, sameSite: "lax" });
    const state = await getAppState();
    const selectedCourse = state.courses[0]
      ? await prisma.course.findUnique({
          where: { id: state.courses[0].id },
          include: { questions: { orderBy: { createdAt: "asc" } }, materials: { orderBy: { createdAt: "desc" } } }
        })
      : null;

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

app.post("/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.render("partials/admin-auth", { error: null });
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

    if (originalCode) {
      const course = await prisma.course.findUnique({ where: { code: originalCode } });
      if (!course) {
        return res.render("partials/admin-alert", { message: "Course not found." });
      }

      try {
        await prisma.course.update({
          where: { id: course.id },
          data: { code, name }
        });
      } catch (error) {
        if (error.code === "P2002") {
          return res.render("partials/admin-alert", { message: "That course code already exists." });
        }
        throw error;
      }
    } else {
      try {
        await prisma.course.create({ data: { code, name } });
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

app.post("/quiz", async (req, res, next) => {
  try {
    const payload = { ...req.query, ...req.body };
    const courseId = (payload.courseId || "").trim();
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: { questions: true }
    });

    if (!course) {
      return res.render("partials/quiz-error", { message: "Selected course was not found." });
    }

    const name = (payload.name || payload.candidateName || "").trim();
    const institution = (payload.institution || payload.organization || "").trim();
    if (!name || !institution) {
      return res.render("partials/quiz-error", { message: "Registration details are required." });
    }

    if (course.questions.length < 20) {
      return res.render("partials/quiz-error", {
        message: `This track needs at least 20 questions. It currently has ${course.questions.length}.`
      });
    }

    const selectedQuestions = course.questions.sort(() => Math.random() - 0.5).slice(0, 20);
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

    res.render("partials/quiz-view", {
      attempt,
      course,
      questions: selectedQuestions,
      durationMinutes
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
    await prisma.courseMaterial.create({
      data: {
        courseId,
        title: req.body.title || req.file.originalname,
        filename: req.file.filename,
        filepath: req.file.path,
        filesize: req.file.size,
        mimeType: req.file.mimetype
      }
    });
    const updatedCourse = await prisma.course.findUnique({
      where: { id: courseId },
      include: { materials: { orderBy: { createdAt: "desc" } } }
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
    if (!fs.existsSync(material.filepath)) return res.status(404).send("File not found on disk.");
    res.download(material.filepath, material.filename);
  } catch (err) {
    next(err);
  }
});

app.post("/admin/materials/delete/:id", requireAdmin, async (req, res, next) => {
  try {
    const material = await prisma.courseMaterial.findUnique({ where: { id: req.params.id } });
    if (!material) return res.render("partials/admin-alert", { message: "Material not found." });
    const courseId = material.courseId;
    if (fs.existsSync(material.filepath)) fs.unlinkSync(material.filepath);
    await prisma.courseMaterial.delete({ where: { id: material.id } });
    const updatedCourse = await prisma.course.findUnique({
      where: { id: courseId },
      include: { materials: { orderBy: { createdAt: "desc" } } }
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
  // await ensureSeedData();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
