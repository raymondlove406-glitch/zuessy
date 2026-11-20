let mode = "login";
let csrfToken = "";

const $ = (id) => document.getElementById(id);
const money = (n) => "$" + Number(n || 0).toFixed(2);

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.method && options.method !== "GET") headers["x-csrf-token"] = csrfToken;
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}
async function refreshCsrf() {
  const data = await api("/api/csrf");
  csrfToken = data.csrfToken;
}
function showMessage(id, text, bad=false) {
  $(id).textContent = text;
  $(id).style.color = bad ? "#ff9b9b" : "var(--green)";
}
function setMode(next) {
  mode = next;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("refLabel").classList.toggle("hidden", mode !== "register");
  $("authSubmit").textContent = mode === "login" ? "Sign in securely" : "Create account";
  $("authForm").elements.password.autocomplete = mode === "login" ? "current-password" : "new-password";
}
$("loginTab").onclick = () => setMode("login");
$("registerTab").onclick = () => setMode("register");

$("authForm").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = {
    email: form.get("email"),
    password: form.get("password"),
    ...(mode === "register" ? { referralCode: form.get("referralCode") || undefined } : {})
  };
  try {
    await refreshCsrf();
    await api(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
      method: "POST", body: JSON.stringify(body)
    });
    await loadDashboard();
  } catch (e) { showMessage("authMessage", e.message, true); }
};

async function loadDashboard() {
  try {
    await refreshCsrf();
    const { user } = await api("/api/me");
    const data = await api("/api/dashboard");
    $("auth").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    $("userEmail").textContent = user.email;
    $("refCode").textContent = user.referralCode;
    $("refCount").textContent = data.referralCount;
    $("hashRate").textContent = data.mining ? Number(data.mining.hashRateTh).toFixed(2) + " TH/s" : "No data";
    $("net").textContent = data.mining ? money(data.mining.netUsd) : "—";
    $("payoutList").innerHTML = renderPayouts(data.payouts);
    if (user.role === "ADMIN") await loadAdmin();
  } catch (_) {
    $("auth").classList.remove("hidden");
    $("dashboard").classList.add("hidden");
  }
}
function renderPayouts(rows) {
  if (!rows?.length) return "No payout requests yet.";
  return `<table><thead><tr><th>Requested</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead><tbody>${
    rows.map(p => `<tr><td>${new Date(p.createdAt).toLocaleString()}</td><td>${money(p.amountUsd)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.transactionHash || "—")}</td></tr>`).join("")
  }</tbody></table>`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
$("copyRef").onclick = async () => {
  try { await navigator.clipboard.writeText($("refCode").textContent); $("copyRef").textContent = "Copied"; }
  catch { $("copyRef").textContent = "Copy unavailable"; }
};
$("payoutForm").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/payouts", { method: "POST", body: JSON.stringify({
      amountUsd: Number(form.get("amountUsd")), destination: form.get("destination")
    })});
    showMessage("payoutMessage", result.message);
    event.currentTarget.reset();
    await loadDashboard();
  } catch (e) { showMessage("payoutMessage", e.message, true); }
};
$("logout").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); location.reload(); }
  catch (e) { alert(e.message); }
};
async function loadAdmin() {
  $("adminPanel").classList.remove("hidden");
  const overview = await api("/api/admin/overview");
  $("adminStats").innerHTML = `<div class="metric"><small>Total accounts</small><strong>${overview.users}</strong></div><div class="metric"><small>Pending payout requests</small><strong>${overview.pendingPayouts}</strong></div><div class="metric"><small>Audit entries shown</small><strong>${overview.recentAudit.length}</strong></div>`;
  const { payouts } = await api("/api/admin/payouts");
  if (!payouts.length) { $("adminPayouts").textContent = "No payout requests."; return; }
  $("adminPayouts").innerHTML = `<table><thead><tr><th>User</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${
    payouts.map(p => `<tr><td>${escapeHtml(p.user.email)}</td><td>${money(p.amountUsd)}</td><td>${escapeHtml(p.status)}</td><td>${p.status === "REQUESTED" ? `<button class="secondary" data-id="${escapeHtml(p.id)}" data-status="APPROVED">Approve</button> <button class="secondary" data-id="${escapeHtml(p.id)}" data-status="REJECTED">Reject</button>` : "—"}</td></tr>`).join("")
  }</tbody></table>`;
  $("adminPayouts").querySelectorAll("button[data-id]").forEach(button => {
    button.onclick = async () => {
      try {
        await api("/api/admin/payouts/" + encodeURIComponent(button.dataset.id), {
          method: "PATCH", body: JSON.stringify({ status: button.dataset.status })
        });
        await loadAdmin();
      } catch (e) { alert(e.message); }
    };
  });
}
refreshCsrf().then(loadDashboard).catch(() => {});
