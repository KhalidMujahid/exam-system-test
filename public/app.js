let timerHandle = null;

const PAGE_META = {
  "/home": { nav: "home", title: "Overview" },
  "/materials": { nav: "materials", title: "Course Materials" },
  "/portal": { nav: "portal", title: "Take an Assessment" },
  "/certifications": { nav: "certifications", title: "Certifications" },
  "/verify": { nav: "verify", title: "Verify Certificate" },
  "/admin": { nav: "admin", title: "Admin Dashboard" },
  "/admin/login": { nav: "admin", title: "Administrative Access" },
  "/certificates/generate": { nav: "generate", title: "Generate Certificate" }
};

function setLoaderVisible(visible) {
  const loader = document.getElementById("global-loader");
  if (!loader) return;
  loader.classList.toggle("is-visible", visible);
}

function setActiveNav(target) {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.nav === target);
    if (el.dataset.nav === target) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

function updatePageTitle(title) {
  const el = document.querySelector("[data-page-title]");
  if (el && title) el.textContent = title;
  if (title) document.title = title + " · CyberCops Academy";
}

function routeMeta(path) {
  if (!path) return null;
  if (path === "/") return PAGE_META["/home"];
  path = path.split("?")[0];
  if (path.startsWith('/certifications/')) return { nav: 'certifications', title: 'Course Payment' };
  if (path.startsWith('/courses/access/')) return { nav: 'certifications', title: 'Your Course' };
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
  document.querySelector('[data-sidebar-toggle]')?.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  const shell = document.getElementById("app-shell");
  if (shell) shell.classList.remove("is-sidebar-open");
  document.querySelector('[data-sidebar-toggle]')?.setAttribute('aria-expanded', 'false');
}
function bindSidebar() {
  const shell = document.getElementById("app-shell");
  if (!shell) return;

  shell.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => shell.classList.contains('is-sidebar-open') ? closeSidebar() : openSidebar());
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
/* Admin workspace navigation               */
/* ------------------------------------------------------------------ */


function initAdminNav() {
  const nav = document.querySelector("[data-admin-nav]");
  const sections = Array.from(document.querySelectorAll("[data-admin-section]"));
  if (!nav || sections.length === 0) return;

  const links = Array.from(nav.querySelectorAll('a[href^="#"]'));

  const activate = (id) => {
    const selected = sections.find(section => section.id === id) || sections[0];
    sections.forEach(section => { section.hidden = section !== selected; });
    links.forEach(link => {
      const active = link.hash === '#' + selected.id;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    nav.dataset.activeSection = selected.id;
  };
  activate(nav.dataset.activeSection || location.hash.slice(1));
  if (nav.dataset.bound === '1') return;
  nav.dataset.bound = '1';
  document.querySelectorAll('[data-admin-open]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); activate(link.dataset.adminOpen);
    history.replaceState(null, '', '#' + link.dataset.adminOpen);
  }));
  links.forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); activate(link.hash.slice(1));
    history.replaceState(null, '', link.hash);
  }));

}

/* ------------------------------------------------------------------ */
/* Portal submit button (pay vs start)                                */
/* ------------------------------------------------------------------ */
const ICON_CARD = '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>';
const ICON_PLAY = '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';

function syncPortalSubmit() {
  const button = document.getElementById("portal-submit");
  const label = document.getElementById("portal-submit-label");
  const icon = document.getElementById("portal-submit-icon");
  if (!button || !label) return;

  const apply = () => {
    const selected = document.querySelector('input[name="courseId"]:checked');
    const paid = selected ? selected.dataset.requiresPayment === "true" : true;
    label.textContent = paid ? "Proceed to Payment" : "Start Test";
    if (icon) icon.innerHTML = paid ? ICON_CARD : ICON_PLAY;
    button.dataset.mode = paid ? "payment" : "free";
  };

  document.querySelectorAll('input[name="courseId"]').forEach((radio) => {
    if (radio.dataset.bound === "1") return;
    radio.dataset.bound = "1";
    radio.addEventListener("change", apply);
  });

  apply();
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

  if (!timer || !display || !form) return;

  timer.dataset.bound = "1";
  const deadline = Number(timer.dataset.deadline) || Date.now() + Number(timer.dataset.seconds || 0) * 1000;
  timer.dataset.deadline = String(deadline);
  let seconds;

  const tick = () => {
    seconds = Math.ceil((deadline - Date.now()) / 1000);
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
  syncPortalSubmit();
  initAdminNav();

  const outcomeBadge = document.getElementById("outcome-badge");
  if (outcomeBadge && outcomeBadge.textContent.includes("PASS") && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !outcomeBadge.dataset.celebrated) {
    outcomeBadge.dataset.celebrated = '1';
    createConfetti();
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  setLoaderVisible(false);
  const meta = routeMeta(location.pathname);
  if (meta) setActiveNav(meta.nav);
  bindSidebar();
  refreshDynamicUI();
});

document.addEventListener("htmx:beforeRequest", () => {
  setLoaderVisible(true);
  const notice = document.getElementById('request-notice');
  if (notice) notice.hidden = true;
});
document.addEventListener("htmx:responseError", () => setLoaderVisible(false));
document.addEventListener("htmx:afterRequest", (event) => {
  setLoaderVisible(false);
  if (event.detail.failed) {
    const notice = document.getElementById('request-notice');
    if (notice) { notice.hidden = false; notice.textContent = 'We could not complete that request. Check your connection and try again.'; }
  }
});
document.addEventListener('htmx:historyRestore', () => {
  const meta = routeMeta(location.pathname);
  if (meta) { setActiveNav(meta.nav); updatePageTitle(meta.title); }
  refreshDynamicUI();
});

document.addEventListener("htmx:afterSwap", (event) => {
  setLoaderVisible(false);

  if (event.detail.target && event.detail.target.id === "main") {
    const path = (event.detail.pathInfo && event.detail.pathInfo.requestPath) || location.pathname;
    const meta = routeMeta(path);
    if (meta) {
      setActiveNav(meta.nav);
      updatePageTitle(meta.title);
    }
    closeSidebar();
    event.detail.target.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
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
