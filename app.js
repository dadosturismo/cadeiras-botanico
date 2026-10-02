// Configure esta URL após publicar o arquivo code.gs como Web App no Google Apps Script.
const GAS_URL = "https://script.google.com/macros/s/AKfycbzGFqdKJ3rmw_57km2F__zNtvv6hWy9Xx9nilvyntgDPfp-qXiRqWmBChARYUC39Bdc0w/exec";
const DB_NAME = "ctur-cadeiras-jardim-v1";
const PENDING_STORE = "pendentes";
const CACHE_STORE = "cache";
const PREFERENCES_STORE = "preferencias";
const SESSION_TOKEN_KEY = "cturCadeirasSessionToken";
const SESSION_USER_KEY = "cturCadeirasSessionUser";
const $ = (id) => document.getElementById(id);

let sessionToken = localStorage.getItem(SESSION_TOKEN_KEY) || "";
let sessionUser = localStorage.getItem(SESSION_USER_KEY) || "";
let panel;
let syncing = false;
let retryTimer;
let selectedReturnId = "";
let localOperationOrder = Date.now();

const db = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore(PENDING_STORE, { keyPath: "idOperacao" });
    database.createObjectStore(CACHE_STORE);
    database.createObjectStore(PREFERENCES_STORE);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function readValue(store, key) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const request = database.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeValue(store, value, key) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    const objectStore = transaction.objectStore(store);
    if (key === undefined) objectStore.put(value);
    else objectStore.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function removeValue(store, key) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function pendingRecords() {
  const database = await db;
  return new Promise((resolve, reject) => {
    const request = database.transaction(PENDING_STORE, "readonly").objectStore(PENDING_STORE).getAll();
    request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.ordem - b.ordem));
    request.onerror = () => reject(request.error);
  });
}

function show(element, visible) { element.classList.toggle("hidden", !visible); }
function selected(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value || ""; }
function newId() { return crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`; }
function currentTime() { return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function isTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")); }
function showLogin(message = "", error = false) {
  show($("bootScreen"), false); show($("appShell"), false); show($("sessionBar"), false); show($("loginScreen"), true);
  setLoginMessage(message, error);
}
function setLoginMessage(message = "", error = false) { $("loginMessage").textContent = message; $("loginMessage").classList.toggle("error", error); }
function setFormMessage(message = "", error = false) { $("formMessage").textContent = message; $("formMessage").classList.toggle("error", error); }
function isSessionError(error) { return /sessão inválida/i.test(String(error?.message || error || "")); }

function encodePayload(data) {
  let binary = "";
  new TextEncoder().encode(JSON.stringify(data)).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function rpc(action, payload) {
  return new Promise((resolve, reject) => {
    if (!navigator.onLine) return reject(new Error("Sem conexão."));
    if (GAS_URL.startsWith("COLE_AQUI")) return reject(new Error("Configure a URL do Web App no arquivo app.js."));
    const nonce = newId();
    const timeout = setTimeout(() => cleanup(new Error("O servidor não respondeu.")), 30000);
    function receive(event) {
      const response = event.data?.resposta;
      if (event.data?.tipo !== "cadeiras-pwa" || response?.nonce !== nonce) return;
      cleanup(); response.sucesso ? resolve(response) : reject(new Error(response.erro || "Falha no servidor."));
    }
    function cleanup(error) { clearTimeout(timeout); window.removeEventListener("message", receive); if (error) reject(error); }
    window.addEventListener("message", receive);
    const form = document.createElement("form"); form.method = "POST"; form.action = GAS_URL; form.target = "bridge";
    [["action", action], ["payload", encodePayload(payload || {})], ["origin", location.origin], ["nonce", nonce], ["token", sessionToken]].forEach(([name, value]) => {
      const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input);
    });
    document.body.append(form); form.submit(); form.remove();
  });
}

function populateSelect(element, values, placeholder) {
  const current = element.value;
  element.replaceChildren(new Option(placeholder, ""));
  values.forEach((value) => element.add(new Option(value, value)));
  if (values.includes(current)) element.value = current;
}

function populateFormOptions() {
  if (!panel?.opcoes) return;
  populateSelect($("situation"), panel.opcoes.situacoes, "Selecione");
  populateSelect($("state"), panel.opcoes.estados, "Selecione o estado");
  populateSelect($("motivation"), panel.opcoes.motivacoes, "Selecione");
  populateSelect($("howHeard"), panel.opcoes.comoSoube, "Selecione");
  populateSelect($("permanence"), panel.opcoes.permanencias, "Selecione");
}

async function mergePanelWithPending(remotePanel) {
  const queued = await pendingRecords();
  const activeById = new Map((remotePanel.ativos || []).map((loan) => [loan.id, loan]));
  queued.forEach((operation) => {
    if (operation.tipo === "emprestar" && !activeById.has(operation.dados.id)) activeById.set(operation.dados.id, { ...operation.dados, criadoEm: operation.dados.criadoEm || new Date().toISOString(), pendente: true });
    if (operation.tipo === "devolver" && activeById.has(operation.dados.id)) activeById.set(operation.dados.id, { ...activeById.get(operation.dados.id), devolucaoPendente: true, horarioDevolucao: operation.dados.horarioDevolucao });
  });
  panel = { ...remotePanel, ativos: Array.from(activeById.values()).sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm))) };
  await writeValue(CACHE_STORE, { usuario: sessionUser, painel: panel }, "painel");
}

async function enterApp(remotePanel) {
  sessionUser = remotePanel.usuario || sessionUser;
  localStorage.setItem(SESSION_USER_KEY, sessionUser);
  await mergePanelWithPending(remotePanel);
  $("sessionUser").textContent = `Acesso: ${sessionUser}`;
  show($("bootScreen"), false); show($("loginScreen"), false); show($("appShell"), true); show($("sessionBar"), true);
  populateFormOptions(); renderDashboard(); await updateStatus();
}

async function refreshPanel() {
  const response = await rpc("painel", {});
  await enterApp(response.dados);
}

async function restoreSession() {
  if (!sessionToken || !sessionUser) return showLogin();
  const cached = await readValue(CACHE_STORE, "painel");
  if (!navigator.onLine) {
    if (!cached?.painel || cached.usuario !== sessionUser) return showLogin("Conecte à internet para validar este dispositivo pela primeira vez.", true);
    await enterApp(cached.painel); return;
  }
  try { await refreshPanel(); }
  catch (error) { clearLocalSession(); showLogin(error.message || "Não foi possível validar o acesso.", true); }
}

function clearLocalSession() {
  sessionToken = ""; sessionUser = ""; panel = undefined;
  localStorage.removeItem(SESSION_TOKEN_KEY); localStorage.removeItem(SESSION_USER_KEY);
}

async function submitLogin(event) {
  event.preventDefault(); const login = $("login").value.trim(); const senha = $("password").value;
  if (!login || !senha) return setLoginMessage("Informe login e senha.", true);
  $("loginSubmit").disabled = true; setLoginMessage();
  try {
    const response = await rpc("login", { login, senha });
    sessionToken = response.dados.token; sessionUser = response.dados.usuario;
    localStorage.setItem(SESSION_TOKEN_KEY, sessionToken); localStorage.setItem(SESSION_USER_KEY, sessionUser); $("password").value = "";
    await enterApp(response.dados.painel);
  } catch (error) { setLoginMessage(error.message || "Não foi possível entrar.", true); }
  finally { $("loginSubmit").disabled = false; }
}

async function logout() {
  const token = sessionToken;
  try { if (navigator.onLine && token) await rpc("logout", {}); } catch (_) {}
  clearLocalSession(); showLogin(); $("login").focus();
}

function configureOrigin() {
  const origin = selected("originType"); const visitor = origin === "Visitante"; const city = origin === "Curitiba e Região Metropolitana";
  const nationality = selected("nationality"); const foreign = nationality === "Estrangeiro";
  show($("automaticOrigin"), city); show($("nationalityField"), visitor); show($("stateField"), visitor && nationality === "Brasileiro"); show($("countryField"), visitor && foreign); show($("motivationField"), visitor); show($("motivationOtherField"), visitor && $("motivation").value === "Outro");
  if (city) { $("country").value = "Brasil"; $("state").value = "Paraná"; $("motivation").value = ""; $("motivationOther").value = ""; }
  if (visitor && nationality === "Brasileiro") { $("country").value = "Brasil"; hideCountrySuggestions(); }
  if (foreign && $("country").value === "Brasil") $("country").value = "";
}

function configureOther(selectId, fieldId, inputId) {
  const isOther = $(selectId).value === "Outro"; show($(fieldId), isOther); if (!isOther) $(inputId).value = "";
}

function matchingCountries(value) {
  const search = String(value || "").trim().toLocaleLowerCase("pt-BR"); if (!search || !panel?.opcoes?.paises) return [];
  return panel.opcoes.paises.filter((country) => country.toLocaleLowerCase("pt-BR").includes(search)).slice(0, 10);
}
function hideCountrySuggestions() { show($("countrySuggestions"), false); $("country").setAttribute("aria-expanded", "false"); }
function setCountry(country) { $("country").value = country; hideCountrySuggestions(); }
function renderCountrySuggestions() {
  const suggestions = $("countrySuggestions"); suggestions.replaceChildren(); const countries = matchingCountries($("country").value);
  if (!countries.length) return hideCountrySuggestions();
  countries.forEach((country) => { const button = document.createElement("button"); button.type = "button"; button.className = "suggestion"; button.textContent = country; button.addEventListener("pointerdown", (event) => { event.preventDefault(); setCountry(country); }); button.addEventListener("click", () => setCountry(country)); suggestions.append(button); });
  show(suggestions, true); $("country").setAttribute("aria-expanded", "true");
}

function maskCpf(value) { const digits = String(value).replace(/\D/g, "").slice(0, 11); return digits.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"); }
function maskPhone(value) { const digits = String(value).replace(/\D/g, "").slice(0, 11); if (digits.length <= 10) return digits.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2"); return digits.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2"); }
function choiceText(value, other) { return value === "Outro" ? `Outro: ${other || ""}` : value; }

function frontEndValid() {
  const origin = selected("originType"), nationality = selected("nationality"), country = $("country").value;
  const needsOther = [["situation", "situationOther"], ["motivation", "motivationOther"], ["howHeard", "howHeardOther"], ["permanence", "permanenceOther"]].every(([selectId, otherId]) => $(selectId).value !== "Outro" || $(otherId).value.trim());
  const validVisitorOrigin = nationality && (nationality === "Estrangeiro" ? panel.opcoes.paises.includes(country) : Boolean($("state").value)) && $("motivation").value;
  return Boolean($("attendant").value.trim() && $("requester").value.trim() && $("cpf").value.replace(/\D/g, "").length === 11 && $("phone").value.trim() && $("situation").value && origin && $("howHeard").value && $("permanence").value && isTime($("withdrawalTime").value) && needsOther && (origin === "Curitiba e Região Metropolitana" || validVisitorOrigin));
}

function collectLoan() {
  return { id: newId(), criadoEm: new Date().toISOString(), atendente: $("attendant").value.trim(), solicitante: $("requester").value.trim(), cpf: $("cpf").value.replace(/\D/g, ""), telefone: $("phone").value.trim(), situacao: $("situation").value, situacaoOutro: $("situationOther").value.trim(), procedencia: selected("originType"), nacionalidade: selected("originType") === "Curitiba e Região Metropolitana" ? "Brasileiro" : selected("nationality"), pais: selected("originType") === "Curitiba e Região Metropolitana" || selected("nationality") === "Brasileiro" ? "Brasil" : $("country").value, estado: selected("originType") === "Curitiba e Região Metropolitana" ? "Paraná" : selected("nationality") === "Brasileiro" ? $("state").value : "", motivacao: selected("originType") === "Curitiba e Região Metropolitana" ? "Curitiba e Região Metropolitana" : $("motivation").value, motivacaoOutro: $("motivationOther").value.trim(), comoSoube: $("howHeard").value, comoSoubeOutro: $("howHeardOther").value.trim(), horarioRetirada: $("withdrawalTime").value, permanencia: $("permanence").value, permanenciaOutro: $("permanenceOther").value.trim(), observacoes: $("notes").value.trim() };
}

async function addPending(type, dados) { await writeValue(PENDING_STORE, { idOperacao: `${type}-${newId()}`, tipo: type, dados: dados, ordem: ++localOperationOrder }); }

async function saveLoan(event) {
  event.preventDefault(); setFormMessage();
  if (!frontEndValid()) return setFormMessage("Preencha todos os campos obrigatórios e selecione uma opção válida.", true);
  const loan = collectLoan(); $("saveLoan").disabled = true;
  try {
    await addPending("emprestar", loan);
    panel.ativos = [{ ...loan, pendente: true }, ...(panel.ativos || [])];
    await writeValue(CACHE_STORE, { usuario: sessionUser, painel: panel }, "painel");
    await rememberAttendant(loan.atendente); resetForm(); openDashboard(); synchronize();
  } catch (error) { setFormMessage(error.message || "Não foi possível guardar o empréstimo neste dispositivo.", true); }
  finally { $("saveLoan").disabled = false; }
}

async function rememberAttendant(value) { await writeValue(PREFERENCES_STORE, value, "atendente"); }
async function resetForm() {
  $("loanForm").reset(); $("withdrawalTime").value = currentTime(); $("attendant").value = await readValue(PREFERENCES_STORE, "atendente") || "";
  ["situationOtherField", "nationalityField", "stateField", "countryField", "motivationField", "motivationOtherField", "howHeardOtherField", "permanenceOtherField", "automaticOrigin"].forEach((id) => show($(id), false)); hideCountrySuggestions(); setFormMessage();
}

function field(label, value) { const item = document.createElement("div"); item.className = "loan-item"; const title = document.createElement("b"); title.textContent = label; const text = document.createElement("span"); text.textContent = value || "—"; item.append(title, text); return item; }
function renderDashboard() {
  const loans = panel?.ativos || []; $("activeCount").textContent = String(loans.length); const list = $("activeList"); list.replaceChildren(); show($("emptyState"), loans.length === 0);
  loans.forEach((loan) => {
    const card = document.createElement("article"); card.className = "loan"; const top = document.createElement("div"); top.className = "loan-top"; const title = document.createElement("div"); const h3 = document.createElement("h3"); h3.textContent = loan.solicitante; const small = document.createElement("small"); small.textContent = `${loan.pendente ? "Empréstimo aguardando sincronização · " : ""}Retirada: ${loan.horarioRetirada}`; title.append(h3, small); top.append(title); card.append(top);
    const grid = document.createElement("div"); grid.className = "loan-grid"; [["CPF", maskCpf(loan.cpf)], ["Telefone", loan.telefone], ["Atendente", loan.atendente], ["Situação", choiceText(loan.situacao, loan.situacaoOutro)], ["Procedência", `${loan.procedencia} · ${loan.pais}${loan.estado ? ` · ${loan.estado}` : ""}`], ["Motivação", choiceText(loan.motivacao, loan.motivacaoOutro)], ["Como ficou sabendo", choiceText(loan.comoSoube, loan.comoSoubeOutro)], ["Permanência", choiceText(loan.permanencia, loan.permanenciaOutro)], ["Observações", loan.observacoes]].forEach(([label, value]) => grid.append(field(label, value))); card.append(grid);
    const button = document.createElement("button"); button.type = "button"; button.className = "delivered"; button.dataset.id = loan.id; button.disabled = Boolean(loan.devolucaoPendente); button.textContent = loan.devolucaoPendente ? "Devolução aguardando sincronização" : "Entregue"; card.append(button); list.append(card);
  });
}

function openDashboard() { show($("formScreen"), false); show($("dashboardScreen"), true); renderDashboard(); window.scrollTo({ top: 0, behavior: "smooth" }); }
async function openForm() { await resetForm(); show($("dashboardScreen"), false); show($("formScreen"), true); window.scrollTo({ top: 0, behavior: "smooth" }); $("attendant").focus(); }
function openReturnModal(id) { const loan = (panel?.ativos || []).find((item) => item.id === id); if (!loan) return; selectedReturnId = id; $("returnText").textContent = `Confirme a devolução da cadeira emprestada para ${loan.solicitante}.`; $("returnTime").value = currentTime(); $("returnMessage").textContent = ""; show($("returnModal"), true); $("returnTime").focus(); }
function closeReturnModal() { selectedReturnId = ""; show($("returnModal"), false); }

async function confirmReturn() {
  const time = $("returnTime").value; if (!selectedReturnId || !isTime(time)) { $("returnMessage").textContent = "Informe um horário de devolução válido."; $("returnMessage").classList.add("error"); return; }
  $("confirmReturn").disabled = true;
  try {
    await addPending("devolver", { id: selectedReturnId, horarioDevolucao: time, devolvidoEm: new Date().toISOString() });
    panel.ativos = panel.ativos.map((loan) => loan.id === selectedReturnId ? { ...loan, devolucaoPendente: true, horarioDevolucao: time } : loan);
    await writeValue(CACHE_STORE, { usuario: sessionUser, painel: panel }, "painel"); closeReturnModal(); renderDashboard(); synchronize();
  } catch (error) { $("returnMessage").textContent = error.message || "Não foi possível guardar a devolução neste dispositivo."; $("returnMessage").classList.add("error"); }
  finally { $("confirmReturn").disabled = false; }
}

async function updateStatus() {
  const pending = await pendingRecords(); const online = navigator.onLine;
  $("network").textContent = online ? "● Online" : "● Offline"; $("network").className = online ? "online" : "offline";
  $("syncSummary").textContent = pending.length ? `${pending.length} ação(ões) aguardando sincronização` : "Dados sincronizados"; show($("syncNow"), online && pending.length > 0);
}
function scheduleRetry() { if (retryTimer || !navigator.onLine) return; retryTimer = window.setTimeout(() => { retryTimer = undefined; synchronize(); }, 60000); }
async function synchronize() {
  if (syncing || !navigator.onLine || !sessionToken) return updateStatus();
  syncing = true; let retry = false;
  try {
    for (const operation of await pendingRecords()) {
      try { await rpc(operation.tipo === "emprestar" ? "emprestar" : "devolver", operation.dados); await removeValue(PENDING_STORE, operation.idOperacao); }
      catch (error) { if (isSessionError(error)) { clearLocalSession(); showLogin("Sua sessão não é mais válida. Entre novamente.", true); return; } retry = true; break; }
    }
    if (!retry) await refreshPanel();
  } finally { syncing = false; await updateStatus(); if (retry) scheduleRetry(); }
}

$("loginForm").addEventListener("submit", submitLogin);
$("logout").addEventListener("click", logout);
$("togglePassword").addEventListener("click", () => { const visible = $("password").type === "text"; $("password").type = visible ? "password" : "text"; $("togglePassword").setAttribute("aria-label", visible ? "Mostrar senha" : "Ocultar senha"); });
$("addLoan").addEventListener("click", openForm); $("backDashboard").addEventListener("click", openDashboard); $("loanForm").addEventListener("submit", saveLoan);
$("cpf").addEventListener("input", (event) => { event.target.value = maskCpf(event.target.value); }); $("phone").addEventListener("input", (event) => { event.target.value = maskPhone(event.target.value); });
$("situation").addEventListener("change", () => configureOther("situation", "situationOtherField", "situationOther")); $("motivation").addEventListener("change", () => { configureOther("motivation", "motivationOtherField", "motivationOther"); configureOrigin(); }); $("howHeard").addEventListener("change", () => configureOther("howHeard", "howHeardOtherField", "howHeardOther")); $("permanence").addEventListener("change", () => configureOther("permanence", "permanenceOtherField", "permanenceOther"));
document.querySelectorAll('input[name="originType"], input[name="nationality"]').forEach((input) => input.addEventListener("change", configureOrigin)); $("country").addEventListener("input", renderCountrySuggestions); $("country").addEventListener("blur", () => window.setTimeout(hideCountrySuggestions, 150)); $("country").addEventListener("keydown", (event) => { if (event.key === "Escape") hideCountrySuggestions(); });
$("activeList").addEventListener("click", (event) => { const button = event.target.closest("button[data-id]"); if (button && !button.disabled) openReturnModal(button.dataset.id); }); $("cancelReturn").addEventListener("click", closeReturnModal); $("confirmReturn").addEventListener("click", confirmReturn); $("syncNow").addEventListener("click", synchronize);
window.addEventListener("online", async () => { if (!sessionToken) return; try { await refreshPanel(); await synchronize(); } catch (_) { await updateStatus(); } }); window.addEventListener("offline", updateStatus);
(async () => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js"); await restoreSession(); })();
