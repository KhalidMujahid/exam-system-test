let timerHandle = null;

const PAGE_META = {
  "/home": { nav: "home", title: "Dashboard" },
  "/portal": { nav: "portal", title: "Candidate Portal" },
  "/certifications": { nav: "certifications", title: "Certifications" },
  "/verify": { nav: "verify", title: "Verify Certificate" },
  "/admin": { nav: "admin", title: "Admin Console" },
  "/admin/login": { nav: "admin", title: "Administrative Access" },
  "/certificates/generate": { nav: "home", title: "Coming Soon" }
};

function setLoaderVisible(visible) {
  const loader = document.getElementById("global-loader");
  if (!loader) return;
  loader.classList.toggle("is-visible", visible);
}

function setActiveNav(target) {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.nav === target);
  });
}

function updatePageTitle(title) {
  const el = document.querySelector("[data-page-title]");
  if (el && title) el.textContent = title;
  if (title) document.title = title + " · CyberCops Academy";
}

function routeMeta(path) {
  if (!path) return null;
  if (path === "/admin/login") return PAGE_META["/admin/login"];
  if (path === "/admin" || path.startsWith("/admin/")) return PAGE_META["/admin"];
  return PAGE_META[path] || null;
}

/* ------------------------------------------------------------------ */
/* Sidebar (mobile drawer)                                            */
/* ------------------------------------------------------------------ */
function openSidebar() {
  const shell = document.getElementById("app-shell");
  if (shell) shell.classList.add("is-sidebar-open");
}
function closeSidebar() {
  const shell = document.getElementById("app-shell");
  if (shell) shell.classList.remove("is-sidebar-open");
}
function bindSidebar() {
  const shell = document.getElementById("app-shell");
  if (!shell) return;

  shell.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => shell.classList.toggle("is-sidebar-open"));
  });
  shell.querySelectorAll("[data-sidebar-close]").forEach((btn) => {
    btn.addEventListener("click", closeSidebar);
  });
  shell.querySelectorAll(".sidebar-link, .sidebar-brand").forEach((link) => {
    link.addEventListener("click", () => {
      if (window.matchMedia("(max-width: 1024px)").matches) closeSidebar();
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });
}

/* ------------------------------------------------------------------ */
/* Admin section navigation (smooth scroll + scrollspy)               */
/* ------------------------------------------------------------------ */
let adminScrollSpy = null;

function initAdminNav() {
  const nav = document.querySelector("[data-admin-nav]");
  const sections = Array.from(document.querySelectorAll("[data-admin-section]"));
  if (!nav || sections.length === 0) return;

  const links = Array.from(nav.querySelectorAll('a[href^="#"]'));

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.querySelector(link.getAttribute("href"));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", link.getAttribute("href"));
      }
      links.forEach((l) => l.classList.toggle("is-active", l === link));
    });
  });

  if (adminScrollSpy) adminScrollSpy.disconnect();
  if (!("IntersectionObserver" in window)) return;

  adminScrollSpy = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const id = visible.target.id;
      links.forEach((link) => link.classList.toggle("is-active", link.getAttribute("href") === "#" + id));
    },
    { rootMargin: "-30% 0px -55% 0px", threshold: [0.1, 0.4, 0.75] }
  );
  sections.forEach((section) => adminScrollSpy.observe(section));
}

/* ------------------------------------------------------------------ */
/* Quiz progress                                                      */
/* ------------------------------------------------------------------ */
function updateQuizProgress() {
  const form = document.getElementById("quiz-form");
  if (!form) return;
  const radios = form.querySelectorAll('input[type="radio"]');
  const total = form.dataset.questionCount ? Number(form.dataset.questionCount) : 0;
  let answered = 0;
  radios.forEach(function (radio) {
    if (radio.checked) answered++;
  });

  const progressBar = document.getElementById("quiz-progress-bar");
  const progressText = document.getElementById("quiz-progress-text");

  if (progressBar) progressBar.style.width = (total > 0 ? (answered / total) * 100 : 0) + "%";
  if (progressText) progressText.textContent = answered + " of " + total;
}

/* ------------------------------------------------------------------ */
/* Exam timer                                                         */
/* ------------------------------------------------------------------ */
function bindTimer() {
  const timer = document.querySelector("[data-seconds]");
  const display = document.getElementById("timer-display");
  const form = document.getElementById("quiz-form");
  const timerContainer = timer ? timer.closest("[data-timer-root]") : null;

  if (!timer || !display || !form || timer.dataset.bound === "1") return;

  timer.dataset.bound = "1";
  let seconds = Number(timer.dataset.seconds || 0);

  const tick = () => {
    seconds -= 1;
    const minutes = Math.max(0, Math.floor(seconds / 60));
    const remaining = Math.max(0, seconds % 60);
    display.textContent = `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;

    if (timerContainer) {
      timerContainer.classList.remove("premium-timer-warning", "premium-timer-critical");
      if (seconds <= 60) timerContainer.classList.add("premium-timer-critical");
      else if (seconds <= 300) timerContainer.classList.add("premium-timer-warning");
    }

    if (seconds <= 0) {
      clearInterval(timerHandle);
      form.requestSubmit();
    }
  };

  timerHandle = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ */
/* Confetti                                                           */
/* ------------------------------------------------------------------ */
function createConfetti() {
  const colors = ["#6366f1", "#4f46e5", "#22c55e", "#ef4444", "#f59e0b", "#06b6d4"];
  for (let i = 0; i < 60; i++) {
    setTimeout(() => {
      const el = document.createElement("div");
      el.className = "confetti-piece";
      el.style.cssText = `
        width: ${Math.random() * 8 + 4}px;
        height: ${Math.random() * 8 + 4}px;
        top: -10px;
        left: ${Math.random() * 100}vw;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        animation: confettiFall ${Math.random() * 2 + 2}s ease-out forwards;
        animation-delay: ${Math.random() * 0.5}s;
      `;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }, i * 20);
  }
}

function refreshDynamicUI() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  bindTimer();
  updateQuizProgress();
  initAdminNav();

  const outcomeBadge = document.getElementById("outcome-badge");
  if (outcomeBadge && outcomeBadge.textContent.includes("PASS")) createConfetti();
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  setLoaderVisible(false);
  bindSidebar();
  refreshDynamicUI();
});

document.addEventListener("htmx:beforeRequest", () => setLoaderVisible(true));
document.addEventListener("htmx:responseError", () => setLoaderVisible(false));

document.addEventListener("htmx:afterSwap", (event) => {
  setLoaderVisible(false);

  if (event.detail.target && event.detail.target.id === "main") {
    const path = (event.detail.pathInfo && event.detail.pathInfo.requestPath) || "";
    const meta = routeMeta(path);
    if (meta) {
      setActiveNav(meta.nav);
      updatePageTitle(meta.title);
    }
  }

  refreshDynamicUI();
});

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-nav]");
  if (!trigger) return;
  const meta = PAGE_META[trigger.getAttribute("hx-get") || ""];
  if (meta) updatePageTitle(meta.title);
  setActiveNav(trigger.dataset.nav);
});

const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes confettiFall {
    0% { transform: translateY(-10vh) rotate(0deg) scale(1); opacity: 1; }
    100% { transform: translateY(110vh) rotate(720deg) scale(0.4); opacity: 0; }
  }
`;
document.head.appendChild(styleSheet);
