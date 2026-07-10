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
    button.classList.toggle("bg-white/5", !active);
    button.classList.toggle("text-slate-200", !active);
  });
}

function bindTimer() {
  const timer = document.querySelector(".timer-box[data-seconds]");
  const display = document.getElementById("timer-display");
  const form = document.getElementById("quiz-form");

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

    if (seconds <= 0) {
      clearInterval(timerHandle);
      form.requestSubmit();
    }
  };

  timerHandle = setInterval(tick, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
  setLoaderVisible(false);
  bindTimer();
});

document.addEventListener("htmx:beforeRequest", () => {
  setLoaderVisible(true);
});

document.addEventListener("htmx:afterSwap", (event) => {
  setLoaderVisible(false);

  if (event.detail.target && event.detail.target.id === "main") {
    const activeNav = event.detail.pathInfo?.requestPath === "/admin" ? "admin" : "portal";
    setActiveNav(activeNav);
  }

  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  bindTimer();
});

document.addEventListener("htmx:responseError", () => {
  setLoaderVisible(false);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".nav-btn");
  if (!button) return;
  setActiveNav(button.dataset.nav);
});

setLoaderVisible(false);
