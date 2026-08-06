/* ALORIA gate — tries the backend first (deployed on Vercel),
   falls back to a client-side hash check for local preview. */
(function () {
  const gate = document.getElementById("gate");
  const form = document.getElementById("gateForm");
  const input = document.getElementById("gatePass");

  // SHA-256 of the shared password (local-preview fallback only;
  // the deployed check happens server-side in /api/auth).
  const LOCAL_HASH = "896953b0f6c20ca6f5d29330b52e682484825348ef59fd32443b8521038929ad";

  async function sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function openGate() {
    gate.classList.remove("error");
    gate.classList.add("open");
    setTimeout(() => { window.location.href = "/hub/"; }, 1050);
  }

  function reject() {
    gate.classList.remove("error");
    void gate.offsetWidth; // restart animation
    gate.classList.add("error");
    input.value = "";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = input.value.trim();
    if (!pw) return reject();

    // 1) server-side check (works when deployed)
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) { sessionStorage.setItem("aloria_gate", "open"); return openGate(); }
      if (res.status === 401) return reject();
    } catch (_) { /* no backend — local preview */ }

    // 2) local fallback
    try {
      const h = await sha256(pw);
      if (h === LOCAL_HASH) { sessionStorage.setItem("aloria_gate", "open"); return openGate(); }
    } catch (_) { /* SubtleCrypto needs localhost/https */ }
    reject();
  });

  // Waitlist
  const wl = document.getElementById("waitlistForm");
  const wlMsg = document.getElementById("waitlistMsg");
  if (wl) {
    wl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("waitlistEmail").value.trim();
      if (!email) return;
      try {
        await fetch("/api/waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
      } catch (_) { /* offline preview */ }
      wlMsg.textContent = "You're on the list ✦";
      wl.reset();
    });
  }
})();
