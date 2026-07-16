let timerHandle = null;

function setLoaderVisible(visible) {
  const loader = document.getElementById("global-loader");
  if (!loader) return;
  loader.classList.toggle("hidden", !visible);
  loader.classList.toggle("flex", visible);
}

function setActiveNav(target) {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    const active = button.dataset.nav === target;
    button.classList.toggle("bg-white/20", active);
    button.classList.toggle("text-white", active);
    button.classList.toggle("text-white/60", !active);
    button.classList.toggle("hover:bg-white/10", !active);
  });
}

function updateQuizProgress() {
  const form = document.getElementById("quiz-form");
  if (!form) return;
  const radios = form.querySelectorAll('input[type="radio"]');
  const total = form.querySelectorAll('[data-question-count]').length > 0
    ? Number(form.querySelector('[data-question-count]').dataset.questionCount)
    : 0;
  let answered = 0;
  radios.forEach(function(radio) {
    if (radio.checked) answered++;
  });

  const progressBar = document.getElementById("quiz-progress-bar");
  const progressText = document.getElementById("quiz-progress-text");
  const progressPercent = document.getElementById("quiz-progress-percent");

  if (progressBar) {
    const pct = total > 0 ? (answered / total) * 100 : 0;
    progressBar.style.width = pct + "%";
  }
  if (progressText) {
    progressText.textContent = answered + " of " + total + " answered";
  }
  if (progressPercent) {
    progressPercent.textContent = total > 0 ? Math.round((answered / total) * 100) + "%" : "0%";
  }
}

function bindTimer() {
  const timer = document.querySelector("[data-seconds]");
  const display = document.getElementById("timer-display");
  const form = document.getElementById("quiz-form");
  const timerContainer = timer ? timer.closest("[data-timer-root]") : null;

  if (!timer || !display || !form || timer.dataset.bound === "1") {
    return;
  }

  timer.dataset.bound = "1";
  let seconds = Number(timer.dataset.seconds || 0);

  const tick = () => {
    seconds -= 1;
    const minutes = Math.max(0, Math.floor(seconds / 60));
    const remaining = Math.max(0, seconds % 60);
    display.textContent = `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;

    if (timerContainer) {
      timerContainer.classList.remove("premium-timer-warning", "premium-timer-critical");
      if (seconds <= 60) {
        timerContainer.classList.add("premium-timer-critical");
      } else if (seconds <= 300) {
        timerContainer.classList.add("premium-timer-warning");
      }
    }

    if (seconds <= 0) {
      clearInterval(timerHandle);
      form.requestSubmit();
    }
  };

  timerHandle = setInterval(tick, 1000);
}

function createConfetti() {
  const colors = ['#6366f1', '#4f46e5', '#22c55e', '#ef4444', '#f59e0b', '#06b6d4'];
  for (let i = 0; i < 60; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.cssText = `
        position: fixed;
        width: ${Math.random() * 8 + 4}px;
        height: ${Math.random() * 8 + 4}px;
        top: -10px;
        left: ${Math.random() * 100}vw;
        z-index: 1000;
        pointer-events: none;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        border-radius: 2px;
        animation: confettiFall ${Math.random() * 2 + 2}s ease-out forwards;
        animation-delay: ${Math.random() * 0.5}s;
      `;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }, i * 20);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setLoaderVisible(false);
  bindTimer();
  updateQuizProgress();
});

document.addEventListener("htmx:beforeRequest", () => {
  setLoaderVisible(true);
});

document.addEventListener("htmx:afterSwap", (event) => {
  setLoaderVisible(false);

  if (event.detail.target && event.detail.target.id === "main") {
    const path = event.detail.pathInfo?.requestPath || "";
    const activeNav = path === "/admin" || path.startsWith("/admin/") ? "admin" : "portal";
    setActiveNav(activeNav);
  }

  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  bindTimer();
  updateQuizProgress();

  const outcomeBadge = document.getElementById("outcome-badge");
  if (outcomeBadge && outcomeBadge.textContent.includes("PASS")) {
    createConfetti();
  }
});

document.addEventListener("htmx:responseError", () => {
  setLoaderVisible(false);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".nav-btn");
  if (!button) return;
  setActiveNav(button.dataset.nav);
});

const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes confettiFall {
    0% { transform: translateY(-10vh) rotate(0deg) scale(1); opacity: 1; }
    100% { transform: translateY(110vh) rotate(720deg) scale(0.4); opacity: 0; }
  }
`;
document.head.appendChild(styleSheet);

setLoaderVisible(false);