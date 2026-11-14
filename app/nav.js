// "Under the hood" menu. It is a native <details>, so it opens on click and works without this file.
// This only adds the usual extras: Escape closes it, and so does clicking or tabbing away.
(function () {
  "use strict";
  var menu = document.querySelector(".menu");
  if (!menu) return;

  document.addEventListener("click", function (e) {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  menu.addEventListener("focusout", function (e) {
    if (menu.open && e.relatedTarget && !menu.contains(e.relatedTarget)) menu.open = false;
  });
})();
