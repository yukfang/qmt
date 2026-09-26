(function () {
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
  var env = local ? "local" : "cloud";
  var label = local ? "Local" : "Cloud";
  document.documentElement.dataset.env = env;

  var icon = document.querySelector('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.type = "image/svg+xml";
  icon.href = local ? "/favicon-local.svg" : "/favicon-cloud.svg";

  var apple = document.querySelector('link[rel="apple-touch-icon"]');
  if (!apple) {
    apple = document.createElement("link");
    apple.rel = "apple-touch-icon";
    document.head.appendChild(apple);
  }
  apple.href = icon.href;

  var baseTitle = "QMT Bridge";
  if (location.pathname.indexOf("login") !== -1) {
    document.title = label + " · 登录 · " + baseTitle;
  } else if (local && /(?:^|[?&])mode=sim(?:&|$)/.test(location.search)) {
    document.title = label + " · SIM · " + baseTitle;
  } else {
    document.title = label + " · " + baseTitle;
  }

  function paint() {
    var badge = document.getElementById("env-badge");
    if (badge) badge.textContent = label;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", paint);
  } else {
    paint();
  }
})();
