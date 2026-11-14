// Roadmap suggestions: send the form in the background through FormSubmit's AJAX endpoint and
// thank the visitor in place, so they never leave the page. Without JavaScript the form posts to
// FormSubmit directly and comes back to the roadmap.
(function () {
  "use strict";
  var form = document.querySelector("[data-suggest]");
  if (!form || !window.fetch) return;
  var status = form.querySelector("[data-suggest-status]");
  var button = form.querySelector("button[type=submit]");
  var endpoint = form.action.replace("formsubmit.co/", "formsubmit.co/ajax/");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    if (data._honey) return; // a bot filled the hidden field
    delete data._next;
    button.disabled = true;
    status.textContent = "Sending…";
    status.className = "suggest-status";
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (res) {
        if (!res.ok || String(res.body.success) !== "true") throw new Error(res.body.message || "not sent");
        form.reset();
        status.textContent = "Thanks, we got it. Every idea gets read.";
        status.className = "suggest-status is-sent";
      })
      .catch(function () {
        status.textContent = "That didn't send. Please try again in a moment.";
        status.className = "suggest-status is-error";
      })
      .then(function () { button.disabled = false; });
  });
})();
