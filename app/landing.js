// Landing page motion: "Set your ___ up for life" rotates through who the jar is for,
// a stick figure for that person pops up, and one coin drops into the jar per role.
// Everything here is decoration. The page reads fine, and says the same thing, without it.
(function () {
  "use strict";

  var ROLES = [
    { word: "daughter", slug: "daughter" },
    { word: "son", slug: "son" },
    { word: "niece", slug: "niece" },
    { word: "nephew", slug: "nephew" },
    { word: "granddaughter", slug: "granddaughter" },
    { word: "grandson", slug: "grandson" },
    { word: "little sister", slug: "little-sister" },
    { word: "little brother", slug: "little-brother" },
    { word: "loved one", slug: "loved-one" },
  ];
  // frame, patch and underline colours cycle together: orange, pink, blue, green
  var UNDERLINES = ["orange", "pink", "blue", "green"];
  var FRAME_FOR = [1, 2, 3, 4]; // frame-1 orange, frame-2 red/pink, frame-3 blue, frame-4 green
  var STEP_MS = 3400;
  var HOLD_FULL_MS = 3000;

  var wordEl = document.querySelector("[data-role-word]");
  var underlineEl = document.querySelector("[data-role-underline]");
  var eraserEl = document.querySelector("[data-eraser]");
  var cardEl = document.querySelector("[data-card]");
  var figureEl = document.querySelector("[data-card-figure]");
  var frameEl = document.querySelector("[data-card-frame]");
  var jarEl = document.querySelector("[data-jar]");
  var pileEl = document.querySelector("[data-pile]");
  if (!wordEl || !figureEl || !pileEl || !jarEl) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coins = Array.prototype.slice.call(pileEl.querySelectorAll(".coin"));
  var NECK = [46.5, 293.5], JAR_W = 340, JAR_H = 470, COIN_R = 47; // jar.png units, see assets/pile.json

  var index = -1;
  var timer = null;
  var pending = [];

  // preload art so the first pop is not blank
  ROLES.forEach(function (r) { new Image().src = "assets/figure-" + r.slug + ".png"; });
  [1, 2, 3, 4].forEach(function (n) { new Image().src = "assets/frame-" + n + ".png"; });
  UNDERLINES.forEach(function (c) { new Image().src = "assets/underline-" + c + ".png"; });

  function setLater(fn, ms) {
    var t = setTimeout(fn, ms);
    pending.push(t);
    return t;
  }
  function clearPending() {
    pending.forEach(clearTimeout);
    pending = [];
  }

  // ── show one role: word, underline, figure card ──
  function showRole(i, animate) {
    var role = ROLES[i];
    var c = i % 4;
    index = i;

    function apply() {
      wordEl.textContent = role.word;
      underlineEl.src = "assets/underline-" + UNDERLINES[c] + ".png";
      figureEl.src = "assets/figure-" + role.slug + ".png";
      frameEl.src = "assets/frame-" + FRAME_FOR[c] + ".png";
    }

    if (!animate || reduceMotion || !wordEl.animate || !eraserEl) {
      apply();
      return;
    }
    eraseAndWrite(apply);
  }

  // The eraser rubs the old word (and its underline) out from left to right, the new word is written
  // in the same direction, and the figure card pops as the swap happens.
  function eraseAndWrite(apply) {
    var roleEl = wordEl.parentNode;
    var w = roleEl.getBoundingClientRect().width;
    var ew = eraserEl.offsetWidth;
    var ERASE_MS = 560, WRITE_MS = 340;
    var LINEAR = "linear";

    // the eraser's centre follows the leading edge of the erased area, with a little scrub
    var steps = 9, frames = [];
    for (var k = 0; k <= steps; k++) {
      var p = k / steps;
      var x = p * w - ew / 2;
      var wob = k % 2 === 0 ? -1 : 1;
      frames.push({
        offset: p,
        opacity: 1,
        transform: "translate(" + x + "px, " + (wob * 3) + "px) rotate(" + (wob * 5) + "deg)",
      });
    }
    frames[0].opacity = 0.0;
    frames[0].transform = "translate(" + (-ew / 2) + "px, -14px) rotate(-12deg)";
    eraserEl.getAnimations().forEach(function (a) { a.cancel(); });
    eraserEl.animate(frames, { duration: ERASE_MS, easing: LINEAR, fill: "forwards" });

    var wipe = [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }];
    var opts = { duration: ERASE_MS, easing: LINEAR, fill: "forwards" };
    wordEl.animate(wipe, opts);
    underlineEl.animate(wipe, opts).onfinish = function () {
      apply();
      wordEl.getAnimations().concat(underlineEl.getAnimations()).forEach(function (a) { a.cancel(); });
      var write = [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }];
      var wopts = { duration: WRITE_MS, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" };
      wordEl.animate(write, wopts);
      underlineEl.animate(write, wopts);
      var wEnd = roleEl.getBoundingClientRect().width;
      eraserEl.animate(
        [
          { opacity: 1, transform: "translate(" + (w - ew / 2) + "px, 3px) rotate(5deg)" },
          { opacity: 0, transform: "translate(" + (Math.max(w, wEnd) + ew * 0.25) + "px, -18px) rotate(14deg)" },
        ],
        { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards" }
      );
      cardEl.classList.remove("is-popping");
      void cardEl.offsetWidth;
      cardEl.classList.add("is-popping");
    };
  }

  // ── one coin falls into the jar ──
  function dropCoin(n) {
    var coin = coins[n];
    if (!coin) return;
    coin.classList.remove("is-hidden");
    if (reduceMotion || !coin.animate) return;

    var w = jarEl.clientWidth, h = jarEl.clientHeight;
    var x = parseFloat(coin.style.getPropertyValue("--x")) / 100 * JAR_W;
    var y = parseFloat(coin.style.getPropertyValue("--y")) / 100 * JAR_H;
    var rot = parseFloat(coin.style.getPropertyValue("--r"));
    var xDrop = Math.min(Math.max(x, NECK[0] + COIN_R), NECK[1] - COIN_R); // fall straight through the neck, then roll aside
    var dx = (xDrop - x) / JAR_W * w;
    var dy = -(y + 40) / JAR_H * h;
    var fall = coin.animate(
      [
        { translate: dx + "px " + dy + "px", rotate: (rot - 40) + "deg" },
        { translate: "0px 0px", rotate: rot + "deg" },
      ],
      { duration: 620, easing: "cubic-bezier(.55, 0, .9, .55)", fill: "backwards" }
    );
    fall.onfinish = function () {
      coin.animate(
        [{ translate: "0px 0px" }, { translate: "0px " + (-0.035 * h) + "px", offset: 0.45 }, { translate: "0px 0px" }],
        { duration: 340, easing: "ease-out" }
      );
    };
  }

  function emptyJar(done) {
    if (reduceMotion || !coins[0].animate) {
      coins.forEach(function (c) { c.classList.add("is-hidden"); });
      done();
      return;
    }
    var last;
    coins.forEach(function (c, k) {
      last = c.animate(
        [{ opacity: 1, translate: "0px 0px" }, { opacity: 0, translate: "0px 14px" }],
        { duration: 450, delay: k * 25, easing: "ease-in", fill: "forwards" }
      );
    });
    last.onfinish = function () {
      coins.forEach(function (c) {
        c.getAnimations().forEach(function (a) { a.cancel(); });
        c.classList.add("is-hidden");
      });
      done();
    };
  }

  // ── the loop: every step shows the next role and drops the next coin; once the jar is full it
  //    holds a moment, empties, and starts over. Coins are counted separately from roles, so
  //    picking a role by hand never leaves a coin floating. ──
  var dropped = 0;
  var running = false;

  function step() {
    if (dropped >= coins.length) {
      setLater(function () {
        emptyJar(function () {
          dropped = 0;
          setLater(step, 500);
        });
      }, HOLD_FULL_MS);
      return;
    }
    showRole((index + 1) % ROLES.length, true);
    dropCoin(dropped);
    dropped += 1;
    setLater(step, STEP_MS);
  }

  function resumeAfter(ms) {
    if (reduceMotion) return;
    clearPending();
    running = true;
    setLater(step, ms);
  }

  function start() {
    if (reduceMotion) {
      // No autoplay: the whole pile stays in the jar.
      showRole(ROLES.length - 1, false);
      return;
    }
    coins.forEach(function (c) { c.classList.add("is-hidden"); });
    showRole(0, false);
    running = true;
    setLater(function () { dropCoin(0); dropped = 1; }, 700);
    setLater(step, STEP_MS + 700);
  }

  // do not stack up drops while the tab is in the background
  document.addEventListener("visibilitychange", function () {
    if (reduceMotion || !running) return;
    if (document.hidden) clearPending();
    else resumeAfter(600);
  });

  // phones: keep "Make a jar" in reach once the hero button has scrolled away, until the final one shows
  var sticky = document.querySelector("[data-sticky]");
  var heroCta = document.querySelector(".hero .cta");
  var finalCta = document.querySelector("[data-final-cta]");
  if (sticky && heroCta && finalCta && "IntersectionObserver" in window) {
    var seen = { hero: true, final: false };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.target === heroCta) seen.hero = e.isIntersecting;
        else seen.final = e.isIntersecting;
      });
      sticky.classList.toggle("is-visible", !seen.hero && !seen.final);
    });
    io.observe(heroCta);
    io.observe(finalCta);
  }

  start();
})();
