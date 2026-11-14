// Phone menu: close it after a link is picked, on Escape, or on a tap outside it.
(function () {
  "use strict";
  var menu = document.querySelector("[data-menu]");
  if (!menu) return;
  menu.addEventListener("click", function (e) {
    if (e.target.closest("a")) menu.open = false;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  document.addEventListener("click", function (e) {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
})();
