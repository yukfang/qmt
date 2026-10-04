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

  if ("serviceWorker" in navigator && (location.protocol === "https:" || local)) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

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
