(function () {
  const form = document.getElementById("login-form");
  const err = document.getElementById("login-error");

  fetch("/api/session", { cache: "no-store", credentials: "same-origin" })
    .then((res) => {
      if (res.ok) location.replace("/");
    })
    .catch(() => {});

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("username").value,
          password: document.getElementById("password").value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "登录失败");
      }
      location.replace("/");
    } catch (e) {
      err.textContent = e.message || "登录失败";
      err.hidden = false;
    }
  });
})();
