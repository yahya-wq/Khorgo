// ============================================================================
// KHORGO WEB CLIENT — version finale corrigée
// ============================================================================
const socket = io();

const AppState = {
  isConnected: false,
  autoAccept: false,
  session: { workspace: null, provider: null, model: null },
  keys: [], providers: [], models: [], selectedProvider: null,
  activityCount: 0, errorCount: 0,
  lastChatRole: null,
  editorDir: null, editorFile: null
};

let lastAssistantDiv = null;
let currentCwd = null;
let collectingAction = false;
let actionDescription = "";
let lastLineText = "";
let lastLineTime = 0;

// ---------- DOM sécurisé ----------
function el(id) { return document.getElementById(id); }
function on(id, event, fn) {
  const node = el(id);
  if (node) node.addEventListener(event, fn);
  else console.warn("⚠️ Élément introuvable : #" + id);
  return node;
}

const DOM = {
  chat: el("chat-messages"),
  activity: el("activity-list"),
  errors: el("errors-list"),
  input: el("user-input"),
  btnSend: el("btn-send"),
  badgeActivity: el("activity-badge"),
  badgeErrors: el("error-badge"),
  stWorkspace: el("status-workspace"),
  stProvider: el("status-provider"),
  stModel: el("status-model"),
  stAuto: el("status-auto"),
  statusDot: document.querySelector(".status-dot"),
  statusText: document.querySelector(".status-text"),
  tree: el("file-tree"),
  editorPath: el("editor-filepath"),
  editorContent: el("editor-content")
};

// ---------- Navigation panneaux ----------
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    const panel = el("panel-" + btn.dataset.panel);
    if (panel) panel.classList.add("active");
    if (btn.dataset.panel === "editor") requestDir(AppState.editorDir);
    if (btn.dataset.panel === "activity") { AppState.activityCount = 0; updateBadge(DOM.badgeActivity, 0); }
    if (btn.dataset.panel === "errors") { AppState.errorCount = 0; updateBadge(DOM.badgeErrors, 0); }
  });
});
document.querySelectorAll(".btn-clear-panel").forEach(btn => {
  btn.addEventListener("click", () => {
    const list = btn.dataset.clear === "activity" ? DOM.activity : DOM.errors;
    if (list) list.innerHTML = '<div class="empty-state">Vide.</div>';
  });
});

// ---------- Modales ----------
function openModal(id) { const m = el(id); if (m) m.classList.remove("hidden"); }
function closeModal(id) { const m = el(id); if (m) m.classList.add("hidden"); }
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal").forEach(o => o.addEventListener("click", e => { if (e.target === o) o.classList.add("hidden"); }));

// ---------- Nettoyage ----------
function cleanLine(line) {
  return line
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[│┃╽┓┗┛┫┳┻═║─━┄┈┉╭╮╰╯├┤┌┐└┘┏┳┳╋]/g, "")
    .replace(/[⠋⠹⠸⠼⠦⠧⠇⠏]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

// ---------- Rendu Markdown léger (sûr : tout passe par escapeHtml avant d'insérer du HTML) ----------
// Supporte : blocs de code ``` ```, code inline `x`, gras **x**, italique *x*/_x_,
// liens [texte](url), listes à puces "-"/"*", listes numérotées "1.", paragraphes.
// Volontairement minimal (pas de lib externe) : suffisant pour des réponses d'agent IA.
let __codeBlockSeq = 0;
function renderMarkdown(raw) {
  if (!raw) return "";

  // 1) Extraire les blocs de code en premier (avant tout autre traitement,
  // pour que leur contenu ne soit jamais interprété comme du markdown).
  const blocks = [];
  let text = raw.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = "cb-" + (++__codeBlockSeq);
    blocks.push({ id, lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
    return `\u0000CODEBLOCK${blocks.length - 1}\u0000`;
  });

  // 2) Échapper le HTML du reste, puis appliquer le markdown inline.
  const lines = text.split("\n");
  const htmlLines = [];
  let inList = null; // "ul" | "ol" | null

  function inlineMd(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<em>$1</em>");
    s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<em>$1</em>");
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  function closeList() { if (inList) { htmlLines.push(inList === "ul" ? "</ul>" : "</ol>"); inList = null; } }

  for (const line of lines) {
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (ulMatch) {
      if (inList !== "ul") { closeList(); htmlLines.push("<ul>"); inList = "ul"; }
      htmlLines.push(`<li>${inlineMd(ulMatch[1])}</li>`);
    } else if (olMatch) {
      if (inList !== "ol") { closeList(); htmlLines.push("<ol>"); inList = "ol"; }
      htmlLines.push(`<li>${inlineMd(olMatch[1])}</li>`);
    } else if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      htmlLines.push(`<p class="md-h md-h${level}">${inlineMd(hMatch[2])}</p>`);
    } else if (line.trim() === "") {
      closeList();
      htmlLines.push("");
    } else if (/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())) {
      closeList();
      htmlLines.push(line.trim());
    } else {
      closeList();
      htmlLines.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  closeList();

  let html = htmlLines.join("\n").replace(/(?:^|\n)(?:\n)+/g, "\n");

  // 3) Réinjecter les blocs de code sous forme de <pre><code> + bouton copier.
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => {
    const b = blocks[Number(i)];
    const langClass = b.lang ? ` class="lang-${escapeHtml(b.lang)}"` : "";
    const langLabel = b.lang ? `<span class="code-lang">${escapeHtml(b.lang)}</span>` : "<span class=\"code-lang\">texte</span>";
    return `<div class="code-block"><div class="code-block-bar">${langLabel}<button type="button" class="btn-copy-code" data-code-id="${b.id}"><svg class="icon"><use href="#i-file"/></svg> Copier</button></div><pre><code${langClass} id="${b.id}">${escapeHtml(b.code)}</code></pre></div>`;
  });

  return html;
}

// Copie du contenu d'un bloc de code au clic (délégation sur le chat entier).
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-copy-code");
  if (!btn) return;
  const codeEl = document.getElementById(btn.dataset.codeId);
  if (!codeEl) return;
  navigator.clipboard?.writeText(codeEl.textContent || "").then(() => {
    const original = btn.innerHTML;
    btn.innerHTML = '<svg class="icon"><use href="#i-check"/></svg> Copié';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  }).catch(() => {});
});

function captureSessionInfo(cleaned) {
  if (cleaned.includes("Workspace :")) { AppState.session.workspace = cleaned.split("Workspace :")[1].trim(); if (DOM.stWorkspace) DOM.stWorkspace.textContent = AppState.session.workspace; return true; }
  if (cleaned.includes("Provider :")) { AppState.session.provider = cleaned.split("Provider :")[1].trim(); if (DOM.stProvider) DOM.stProvider.textContent = AppState.session.provider; return true; }
  if (cleaned.includes("Model :") || cleaned.includes("Modèle :")) { AppState.session.model = cleaned.split(/Model :|Modèle :/)[1].trim(); if (DOM.stModel) DOM.stModel.textContent = AppState.session.model; return true; }
  // ⚠️ Ordre important : "DÉSACTIVÉ" contient littéralement "ACTIVÉ" comme
  // sous-chaîne — le vérifier en premier, sinon toute ligne annonçant l'état
  // désactivé était mal classée comme activé.
  if (cleaned.includes("DÉSACTIVÉ")) { AppState.autoAccept = false; if (DOM.stAuto) DOM.stAuto.innerHTML = '<svg class="icon"><use href="#i-lock"/></svg> désactivé'; return true; }
  if (cleaned.includes("ACTIVÉ")) { AppState.autoAccept = true; if (DOM.stAuto) DOM.stAuto.innerHTML = '<svg class="icon"><use href="#i-check"/></svg> activé'; return true; }
  return false;
}

// Bannière ASCII imprimée par agent.js au démarrage (nom du projet + astuce
// "/help") : une fois les caractères de cadre et les couleurs retirés par
// cleanLine(), il ne reste que du texte brut sans marqueur reconnaissable.
// Sans ce filtre, ces lignes tombaient dans le cas par défaut de
// classifyMessage() et s'affichaient comme si l'IA les avait dites — alors
// que l'identité "Khorgo" est déjà affichée dans l'en-tête de la page.
function isStartupBanner(cleaned) {
  return (
    cleaned === "khorgo - AI Development Agent" ||
    /^Type a prompt,? or \/help for commands\.?$/i.test(cleaned) ||
    /^Tape (une|ta) (demande|prompt).*\/help/i.test(cleaned)
  );
}

// ---------- Routage ----------
function classifyMessage(cleaned) {
  if (!cleaned || cleaned.length < 2) return null;
  if (cleaned.includes("[ERREUR]") || cleaned.includes("❌")) return { type: "error", content: cleaned };
  const toolMatch = cleaned.match(/\b(Read|Write|Edit|Explore|Search|Command)\b\s+(.+)$/i);
  if (toolMatch) {
    // ✓ marque la fin d'un outil (formatToolLog status="success") ; toute
    // autre variante (…) marque le début (status="running"). Permet à
    // addActivity() de mettre à jour la ligne existante au lieu d'en
    // ajouter une seconde identique.
    const status = cleaned.includes("✓") ? "success" : "running";
    return { type: "tool", tool: toolMatch[1], target: toolMatch[2], status };
  }
  // Lignes du spinner ora ("Exécution :"/"Terminé :"/"Échec :") : pur doublon
  // visuel de formatToolLog (running/success) pour run_command — et en cas
  // d'échec réel, l'erreur est de toute façon déjà renvoyée séparément avec
  // un préfixe ❌ (catché plus haut). On les ignore plutôt que de créer une
  // 3ᵉ ligne d'activité pour la même commande.
  if (/^(Exécution|Terminé|Échec)\s*:/i.test(cleaned)) return null;
  // Réponse à une confirmation ("✅ Approuvé." / "🚫 Refusé.", après [o/n/t]) :
  // ni une erreur, ni une activité d'outil — un statut de session. Vérifié
  // AVANT la règle générique ✅/✓ ci-dessous : sinon seul "Approuvé" (qui
  // contient ✅) passait en Activité, et "Refusé" (aucun marqueur reconnu)
  // retombait par défaut dans la bulle de chat comme si l'IA l'avait dit.
  if (cleaned.includes("Approuvé") || cleaned.includes("Refusé")) return { type: "system", content: cleaned };
  // Bascule auto-accept (via /auto, la modale ⚡, ou "toujours accepter"
  // pendant une confirmation) : même raisonnement. "ACTIVÉ" contient ✅ et
  // passait en Activité ; "DÉSACTIVÉ" n'a aucun marqueur reconnu (et la
  // règle "Auto-accept" ci-dessous, en majuscule, ne matche jamais ces
  // lignes qui écrivent "auto-accept" en minuscule) donc retombait dans la
  // bulle de chat. Vérifié ici, avant ✅/✓, pour que les deux états soient
  // routés pareil.
  if (cleaned.includes("auto-accept") && (cleaned.includes("ACTIVÉ") || cleaned.includes("DÉSACTIVÉ"))) {
    return { type: "system", content: cleaned };
  }
  if (cleaned.includes("✅") || cleaned.includes("✓")) return { type: "success", content: cleaned };
  if (
    cleaned.includes("Workspace :") || cleaned.includes("Provider :") ||
    cleaned.includes("Model :") || cleaned.includes("Modèle :") ||
    cleaned.includes("Auto-accept") || cleaned.includes("Interface :") ||
    /Tour \d+\/\d+/.test(cleaned) ||
    cleaned.startsWith("🤖") || cleaned.startsWith("💡") || cleaned.startsWith("📂") ||
    cleaned.startsWith("🔌") || cleaned.startsWith("🧠") || cleaned.startsWith("📊") ||
    cleaned.startsWith("⏳") || cleaned.startsWith("↩️") || cleaned.startsWith("🔄") ||
    cleaned.includes("Agent terminé") || cleaned.includes("Limite de sécurité") ||
    cleaned.includes("réfléchit") || cleaned.includes("DOSSIER DE TRAVAIL")
  ) return { type: "system", content: cleaned };
  return { type: "assistant", content: cleaned };
}

// ---------- Affichage ----------
function updateBadge(node, n) { if (!node) return; node.textContent = n; node.style.display = n > 0 ? "block" : "none"; }
function addAssistant(text) {
  if (!DOM.chat) return;
  removeThinking();
  if (AppState.lastChatRole === "assistant" && lastAssistantDiv) {
    const raw = (lastAssistantDiv.dataset.raw || "") + "\n" + text;
    lastAssistantDiv.dataset.raw = raw;
    lastAssistantDiv.innerHTML = renderMarkdown(raw);
  } else {
    lastAssistantDiv = document.createElement("div");
    lastAssistantDiv.className = "message assistant";
    lastAssistantDiv.dataset.raw = text;
    lastAssistantDiv.innerHTML = renderMarkdown(text);
    DOM.chat.appendChild(lastAssistantDiv);
  }
  AppState.lastChatRole = "assistant";
  DOM.chat.scrollTop = DOM.chat.scrollHeight;
}
function addUser(text) {
  if (!DOM.chat) return;
  const div = document.createElement("div");
  div.className = "message user";
  div.textContent = text; // texte saisi par l'utilisateur : jamais interprété comme markdown
  DOM.chat.appendChild(div);
  AppState.lastChatRole = "user"; lastAssistantDiv = null;
  DOM.chat.scrollTop = DOM.chat.scrollHeight;
}
let lastSystemDiv = null;
let lastSystemText = null;
function addSystem(text) {
  if (!DOM.chat) return;
  if (lastSystemDiv && lastSystemText === text && AppState.lastChatRole === "system") {
    const count = (Number(lastSystemDiv.dataset.count) || 1) + 1;
    lastSystemDiv.dataset.count = count;
    lastSystemDiv.textContent = `${text} (×${count})`;
    DOM.chat.scrollTop = DOM.chat.scrollHeight;
    return;
  }
  const div = document.createElement("div");
  div.className = "message system";
  div.textContent = text;
  div.dataset.count = "1";
  DOM.chat.appendChild(div);
  AppState.lastChatRole = "system"; lastAssistantDiv = null;
  lastSystemDiv = div; lastSystemText = text;
  DOM.chat.scrollTop = DOM.chat.scrollHeight;
}
let lastRunningActivity = null; // { tool, target, node } — dernière ligne "en cours" en attente de complétion
function addActivity(tool, target, status) {
  if (!DOM.activity) return;
  // Une ligne "success" pour le même outil+cible que la dernière ligne
  // "running" en attente : on met à jour cette ligne en place plutôt que
  // d'empiler une seconde entrée identique pour la même action.
  if (status === "success" && lastRunningActivity &&
      lastRunningActivity.tool === tool && lastRunningActivity.target === target) {
    lastRunningActivity.node.classList.remove("running");
    lastRunningActivity.node.classList.add("success");
    lastRunningActivity = null;
    return;
  }
  const empty = DOM.activity.querySelector(".empty-state"); if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "activity-item " + (status || "");
  div.innerHTML = tool
    ? `<span class="tool-icon">${getToolIcon(tool)}</span><span class="tool-name">${escapeHtml(tool)}</span><span class="tool-target">${escapeHtml(target)}</span>`
    : `<span class="tool-target">${escapeHtml(target)}</span>`;
  DOM.activity.appendChild(div);
  lastRunningActivity = (status === "running") ? { tool, target, node: div } : null;
  DOM.activity.scrollTop = DOM.activity.scrollHeight;
  updateBadge(DOM.badgeActivity, ++AppState.activityCount);
}
let lastRunningChatTool = null; // { tool, target, node } — pendant côté chat (miroir de lastRunningActivity)
function addToolMessage(tool, target, status) {
  if (!DOM.chat) return;
  removeThinking();
  if (status === "success" || status === "error") {
    if (lastRunningChatTool && lastRunningChatTool.tool === tool && lastRunningChatTool.target === target) {
      lastRunningChatTool.node.classList.remove("running");
      lastRunningChatTool.node.classList.add(status);
      lastRunningChatTool = null;
      DOM.chat.scrollTop = DOM.chat.scrollHeight;
      return;
    }
  }
  const wrap = document.createElement("div");
  wrap.className = "message tool";
  const log = document.createElement("div");
  log.className = "tool-log " + (status || "");
  log.innerHTML = tool
    ? `<span class="tool-icon">${getToolIcon(tool)}</span><span class="tool-name">${escapeHtml(tool)}</span><span class="tool-target">${escapeHtml(target)}</span>`
    : `<span class="tool-target">${escapeHtml(target)}</span>`;
  wrap.appendChild(log);
  DOM.chat.appendChild(wrap);
  AppState.lastChatRole = "tool"; lastAssistantDiv = null;
  lastRunningChatTool = (status === "running") ? { tool, target, node: log } : null;
  DOM.chat.scrollTop = DOM.chat.scrollHeight;
}
let thinkingDiv = null;
function addThinking() {
  if (!DOM.chat || thinkingDiv) return;
  const div = document.createElement("div");
  div.className = "message tool";
  div.innerHTML = `<div class="thinking"><span class="spinner"></span>Réflexion en cours…</div>`;
  DOM.chat.appendChild(div);
  thinkingDiv = div;
  AppState.lastChatRole = "tool"; lastAssistantDiv = null;
  DOM.chat.scrollTop = DOM.chat.scrollHeight;
}
function removeThinking() {
  if (thinkingDiv) { thinkingDiv.remove(); thinkingDiv = null; }
}

function addError(content) {
  if (!DOM.errors) return;
  const empty = DOM.errors.querySelector(".empty-state"); if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "error-item";
  div.innerHTML = `<div class="error-time">${new Date().toLocaleTimeString()}</div><div>${escapeHtml(content)}</div>`;
  DOM.errors.appendChild(div);
  DOM.errors.scrollTop = DOM.errors.scrollHeight;
  updateBadge(DOM.badgeErrors, ++AppState.errorCount);
}
function getToolIcon(t) {
  const id = { Read: "i-eye", Write: "i-pencil", Edit: "i-pencil", Explore: "i-folder", Search: "i-search", Command: "i-terminal" }[t] || "i-tool";
  return `<svg class="icon"><use href="#${id}"/></svg>`;
}

// ---------- Questions de l'agent → modales ----------
function handleAgentQuestion(cleaned) {
  if (cleaned === "❯") return true;
  const cwdMatch = cleaned.match(/Dossier actuel : (.+)/i);
  if (cwdMatch) { currentCwd = cwdMatch[1].trim(); return true; }
  if (cleaned.includes("Dans quel dossier veux-tu que ton agent travaille")) { openWorkspaceModal(); return true; }
  const createMatch = cleaned.match(/Le dossier "(.+)" n'existe pas/);
  if (createMatch) {
    openConfirmModal({ title: "Créer le dossier ?", text: `Le dossier "${createMatch[1]}" n'existe pas.`,
      buttons: [{ label: "Oui, créer", icon: "i-check", value: "o", primary: true }, { label: "Non", icon: "i-x", value: "n" }] });
    return true;
  }
  if (cleaned.includes("Action proposée")) { collectingAction = true; actionDescription = ""; return true; }
  if (collectingAction) {
    if (cleaned.includes("Confirmer ?")) {
      collectingAction = false;
      const btns = [{ label: "Oui", icon: "i-check", value: "o", primary: true }, { label: "Non", icon: "i-x", value: "n" }];
      if (cleaned.includes("[t]")) btns.push({ label: "Toujours", icon: "i-unlock", value: "t" });
      openConfirmModal({ title: "Confirmer l'action", text: actionDescription.trim(), buttons: btns });
      return true;
    }
    actionDescription += cleaned + "\n";
    return true;
  }
  // ✅ CORRECTION : regex oui/non avec crochets échappés (plus de faux positifs)
  if (/\[o\/n\]|\[O\/n\]|\[o\/N\]/i.test(cleaned) || /\[o\] oui/.test(cleaned)) {
    const btns = [{ label: "Oui", icon: "i-check", value: "o", primary: true }, { label: "Non", icon: "i-x", value: "n" }];
    if (cleaned.includes("[t]")) btns.push({ label: "Toujours", icon: "i-unlock", value: "t" });
    openConfirmModal({ title: "Question de l'agent", text: cleaned, buttons: btns });
    return true;
  }
  return false;
}
function openWorkspaceModal() {
  const cur = el("ws-current"), inp = el("ws-path");
  if (cur) cur.textContent = currentCwd || "(dossier de l'agent)";
  if (inp) inp.value = "";
  openModal("modal-workspace");
  setTimeout(() => { if (inp) inp.focus(); }, 100);
}
function openConfirmModal({ title, text, buttons }) {
  const t = el("confirm-title"), c = el("confirm-text"), box = el("confirm-buttons");
  if (t) t.textContent = title;
  if (c) c.textContent = text;
  if (!box) return;
  box.innerHTML = "";
  buttons.forEach(b => {
    const btn = document.createElement("button");
    btn.className = b.primary ? "btn btn-primary" : "btn";
    btn.innerHTML = b.icon ? `<svg class="icon"><use href="#${b.icon}"/></svg> ${escapeHtml(b.label)}` : escapeHtml(b.label);
    btn.addEventListener("click", () => { socket.emit("user-input", b.value); closeModal("modal-confirm"); });
    box.appendChild(btn);
  });
  openModal("modal-confirm");
}
on("ws-submit", "click", () => { const v = (el("ws-path")?.value || "").trim(); socket.emit("user-input", v); closeModal("modal-workspace"); });
on("ws-use-current", "click", () => { socket.emit("user-input", ""); closeModal("modal-workspace"); });
on("ws-path", "keydown", e => { if (e.key === "Enter") el("ws-submit")?.click(); });

// ---------- Commandes / → modales ----------
function handleSlashCommand(cmd) {
  switch (cmd) {
    case "/help": openModal("modal-help"); break;
    case "/status": fillStatusModal(); openModal("modal-status"); break;
    case "/keys": openKeysModal(); break;
    case "/model": openModelModal(); break;
    case "/auto": fillAutoModal(); openModal("modal-auto"); break;
    case "/clear": if (DOM.chat) DOM.chat.innerHTML = ""; AppState.lastChatRole = null; lastAssistantDiv = null; break;
    default: socket.emit("user-input", cmd);
  }
}
function fillStatusModal() {
  const w = el("m-status-workspace"), p = el("m-status-provider"), m = el("m-status-model"), a = el("m-status-auto");
  if (w) w.textContent = AppState.session.workspace || "-";
  if (p) p.textContent = AppState.session.provider || "-";
  if (m) m.textContent = AppState.session.model || "-";
  if (a) a.innerHTML = AppState.autoAccept
    ? '<svg class="icon"><use href="#i-check"/></svg> activé'
    : '<svg class="icon"><use href="#i-lock"/></svg> désactivé';
}
function fillAutoModal() {
  const a = el("auto-state");
  if (a) a.innerHTML = "État actuel : " + (AppState.autoAccept
    ? '<svg class="icon"><use href="#i-check"/></svg> ACTIVÉ'
    : '<svg class="icon"><use href="#i-lock"/></svg> DÉSACTIVÉ');
}
on("btn-toggle-auto", "click", () => { closeModal("modal-auto"); socket.emit("user-input", "/auto"); });

// ---------- Clés API ----------
let keysTimeout = null;
function openKeysModal() {
  openModal("modal-keys");
  const list = el("keys-list");
  if (list) list.innerHTML = '<div class="loading">Chargement...</div>';
  if (keysTimeout) clearTimeout(keysTimeout);
  keysTimeout = setTimeout(() => {
    const l = el("keys-list");
    if (l) l.innerHTML = '<div class="empty-state">Le serveur ne répond pas. Vérifie que server.js gère get-keys / set-key / delete-key, puis redémarre-le.</div>';
  }, 2500);
  socket.emit("get-keys");
}
// ---------- Canal structuré (assistant / outils / erreurs / statut) ----------
// Contrepartie côté client du pont IPC corrigé dans server.js : ces
// événements remplacent, pour ces catégories, le parsing fragile par regex
// de classifyMessage() sur le flux texte "agent-output". Le flux texte reste
// utilisé pour tout ce qui n'est pas encore migré (menus /model /keys tapés
// directement, questions de confirmation [o/n/t], bannière de démarrage).
socket.on("agent-assistant", ({ text } = {}) => {
  if (text && text.trim()) addAssistant(text);
});
socket.on("agent-tool", ({ tool, target, status } = {}) => {
  addActivity(tool, target, status);
  addToolMessage(tool, target, status);
});
socket.on("agent-thinking", ({ active } = {}) => {
  if (active) addThinking(); else removeThinking();
});
socket.on("agent-error", ({ text } = {}) => {
  if (!text || !text.trim()) return;
  addErrorCard(text);   // carte propre dans le fil de discussion
  addError(text);        // trace brute conservée dans le panneau "Erreurs"
});
socket.on("agent-warning", ({ text } = {}) => {
  if (text && text.trim()) addSystem("⚠️ " + text);
});
socket.on("agent-notice", ({ text } = {}) => {
  if (text && text.trim()) addSystem(text);
});
socket.on("agent-status", (status = {}) => {
  if (status.workspace) {
    AppState.session.workspace = status.workspace;
    if (DOM.stWorkspace) DOM.stWorkspace.textContent = status.workspace;
  }
  if (status.provider) {
    AppState.session.provider = status.provider;
    if (DOM.stProvider) DOM.stProvider.textContent = status.provider;
  }
  if (status.model) {
    AppState.session.model = status.model;
    if (DOM.stModel) DOM.stModel.textContent = status.model;
  }
  if (typeof status.autoAccept === "boolean") {
    AppState.autoAccept = status.autoAccept;
    if (DOM.stAuto) {
      DOM.stAuto.innerHTML = status.autoAccept
        ? '<svg class="icon"><use href="#i-check"/></svg> activé'
        : '<svg class="icon"><use href="#i-lock"/></svg> désactivé';
    }
  }
});

socket.on("keys-status", s => { if (keysTimeout) clearTimeout(keysTimeout); AppState.keys = s || []; renderKeys(); });
function renderKeys() {
  const list = el("keys-list"); if (!list) return;
  list.innerHTML = "";
  AppState.keys.forEach(s => {
    const row = document.createElement("div");
    row.className = "key-row";
    row.innerHTML = `<div class="key-info"><span class="key-label">${escapeHtml(s.label)}</span>
      <span class="key-state ${s.configured ? "ok" : "ko"}">${s.configured ? '<svg class="icon"><use href="#i-check"/></svg> ' + escapeHtml(s.masked) + " (" + escapeHtml(s.source) + ")" : '<svg class="icon"><use href="#i-x"/></svg> non configurée'}</span></div>
      ${s.configured ? `<button class="btn btn-danger" data-delete-key="${s.provider}"><svg class="icon"><use href="#i-trash"/></svg></button>` : ""}`;
    list.appendChild(row);
  });
  const select = el("key-provider");
  if (select) select.innerHTML = AppState.keys.map(s => `<option value="${s.provider}">${escapeHtml(s.label)}</option>`).join("");
}
on("keys-list", "click", e => { const btn = e.target.closest("[data-delete-key]"); if (btn) socket.emit("delete-key", { provider: btn.dataset.deleteKey }); });
on("btn-save-key", "click", () => {
  const provider = el("key-provider")?.value, key = (el("key-value")?.value || "").trim();
  if (!provider || !key) return;
  socket.emit("set-key", { provider, key });
  const v = el("key-value"); if (v) v.value = "";
});

// ---------- Modèle ----------
let providersTimeout = null;
function openModelModal() {
  AppState.models = []; AppState.selectedProvider = null;
  const sp = el("model-step-provider"), sm = el("model-step-model"), pl = el("providers-list");
  if (sp) sp.classList.remove("hidden");
  if (sm) sm.classList.add("hidden");
  if (pl) pl.innerHTML = '<div class="loading">Chargement...</div>';
  openModal("modal-model");
  if (providersTimeout) clearTimeout(providersTimeout);
  providersTimeout = setTimeout(() => {
    const l = el("providers-list");
    if (l) l.innerHTML = '<div class="empty-state">Le serveur ne répond pas. Vérifie que server.js gère get-providers / get-models / select-model, puis redémarre-le.</div>';
  }, 2500);
  socket.emit("get-providers");
}
socket.on("providers-list", providers => {
  if (providersTimeout) clearTimeout(providersTimeout);
  AppState.providers = providers || [];
  const list = el("providers-list"); if (!list) return;
  list.innerHTML = "";
  if (!AppState.providers.length) { list.innerHTML = '<div class="loading">Aucun fournisseur. Ajoute une clé via « Clés API ».</div>'; return; }
  AppState.providers.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "choice-btn"; btn.textContent = p.name; btn.dataset.provider = p.id;
    list.appendChild(btn);
  });
});
on("providers-list", "click", e => {
  const btn = e.target.closest("[data-provider]"); if (!btn) return;
  AppState.selectedProvider = btn.dataset.provider;
  el("model-step-provider")?.classList.add("hidden");
  el("model-step-model")?.classList.remove("hidden");
  const ml = el("models-list"); if (ml) ml.innerHTML = '<div class="loading"><svg class="icon"><use href="#i-refresh"/></svg> Récupération...</div>';
  const ms = el("model-search"); if (ms) ms.value = "";
  socket.emit("get-models", { providerId: AppState.selectedProvider });
});
socket.on("models-list", ({ models, error }) => {
  AppState.models = models || [];
  const ml = el("models-list"); if (!ml) return;
  if (error) { ml.innerHTML = `<div class="loading"><svg class="icon"><use href="#i-x"/></svg> ${escapeHtml(error)}</div>`; return; }
  renderModels("");
});
function renderModels(term0) {
  const list = el("models-list"); if (!list) return;
  list.innerHTML = "";
  const term = term0.trim().toLowerCase();
  const filtered = term ? AppState.models.filter(m => m.name.toLowerCase().includes(term) || m.id.toLowerCase().includes(term)) : AppState.models;
  const displayed = filtered.slice(0, 30);
  if (!displayed.length) { list.innerHTML = '<div class="loading">Aucun modèle.</div>'; return; }
  displayed.forEach(m => {
    const btn = document.createElement("button");
    btn.className = "choice-btn"; btn.textContent = m.name; btn.title = m.id; btn.dataset.modelId = m.id;
    list.appendChild(btn);
  });
  if (filtered.length > 30) list.insertAdjacentHTML("beforeend", `<div class="loading">... ${filtered.length - 30} autres</div>`);
}
on("model-search", "input", e => renderModels(e.target.value));
on("models-list", "click", e => {
  const btn = e.target.closest("[data-model-id]"); if (!btn) return;
  socket.emit("select-model", { providerId: AppState.selectedProvider, modelId: btn.dataset.modelId });
  closeModal("modal-model");
});
on("btn-back-providers", "click", () => {
  el("model-step-model")?.classList.add("hidden");
  el("model-step-provider")?.classList.remove("hidden");
});

// ---------- Éditeur ----------
let dirTimeout = null;
function requestDir(dirPath) {
  if (DOM.tree) DOM.tree.innerHTML = '<div class="loading">Chargement...</div>';
  if (dirTimeout) clearTimeout(dirTimeout);
  dirTimeout = setTimeout(() => {
    if (DOM.tree) DOM.tree.innerHTML = '<div class="empty-state">Le serveur ne répond pas.<br>Vérifie que server.js gère list-dir / read-file / write-file, puis redémarre-le.</div>';
  }, 2500);
  socket.emit("list-dir", { dirPath: dirPath || null });
}
socket.on("workspace-detected", ws => {
  AppState.editorDir = ws;
  if (el("panel-editor")?.classList.contains("active")) requestDir(ws);
});
socket.on("dir-list", ({ path: dirPath, entries, error }) => {
  if (dirTimeout) clearTimeout(dirTimeout);
  AppState.editorDir = dirPath;
  if (!DOM.tree) return;
  DOM.tree.innerHTML = "";
  const head = document.createElement("div");
  head.className = "file-item current";
  head.innerHTML = `<span class="file-icon"><svg class="icon"><use href="#i-folder"/></svg></span><span class="file-name">${escapeHtml(dirPath)}</span>`;
  DOM.tree.appendChild(head);
  const up = document.createElement("div");
  up.className = "file-item folder";
  up.innerHTML = `<span class="file-icon"><svg class="icon"><use href="#i-arrow-up"/></svg></span><span class="file-name">Dossier parent</span>`;
  up.addEventListener("click", () => requestDir(dirPath.replace(/[\\/][^\\/]+$/, "")));
  DOM.tree.appendChild(up);
  if (error) { DOM.tree.insertAdjacentHTML("beforeend", `<div class="empty-state"><svg class="icon"><use href="#i-x"/></svg> ${escapeHtml(error)}</div>`); return; }
  (entries || []).forEach(e => {
    const item = document.createElement("div");
    item.className = "file-item " + e.type;
    item.innerHTML = `<span class="file-icon"><svg class="icon"><use href="#${e.type === "directory" ? "i-folder" : "i-file"}"/></svg></span><span class="file-name">${escapeHtml(e.name)}</span>`;
    item.addEventListener("click", () => {
      if (e.type === "directory") requestDir(e.path);
      else socket.emit("read-file", { filePath: e.path });
    });
    DOM.tree.appendChild(item);
  });
});
socket.on("file-content", ({ filePath, content, error }) => {
  if (error) { addSystem(error); return; }
  AppState.editorFile = filePath;
  if (DOM.editorPath) DOM.editorPath.textContent = filePath;
  if (DOM.editorContent) DOM.editorContent.value = content;
});
socket.on("file-saved", ({ filePath, ok, error }) => {
  addSystem(ok ? `Fichier sauvegardé : ${filePath}` : error);
});
on("btn-refresh-files", "click", () => requestDir(AppState.editorDir));
on("btn-save-file", "click", () => {
  if (!AppState.editorFile) { addSystem("Aucun fichier ouvert."); return; }
  socket.emit("write-file", { filePath: AppState.editorFile, content: DOM.editorContent?.value || "" });
});

// ---------- Auto-actualisation de l'éditeur ----------
function editorPanelActive() {
  const p = el("panel-editor");
  return !!p && p.classList.contains("active");
}
// ✅ CORRECTION : AppState.editorDir (editorCurrentDir n'existait pas)
function autoRefreshTree() {
  socket.emit("list-dir", { dirPath: AppState.editorDir || null });
}
socket.on("file-saved", ({ ok }) => { if (ok) autoRefreshTree(); });
socket.on("file-content", () => { if (editorPanelActive()) autoRefreshTree(); });
socket.on("agent-output", (raw) => {
  if (!editorPanelActive()) return;
  if (/write_file|edit_file|\bWrite\b|\bEdit\b/.test(raw)) autoRefreshTree();
});

// ---------- WebSocket ----------
socket.on("connect", () => {
  AppState.isConnected = true;
  if (DOM.statusDot) DOM.statusDot.className = "status-dot connected";
  if (DOM.statusText) DOM.statusText.textContent = "Connecté";
  if (DOM.btnSend) DOM.btnSend.disabled = false;
  addSystem("Connecté au serveur");
});
socket.on("disconnect", () => {
  AppState.isConnected = false;
  if (DOM.statusDot) DOM.statusDot.className = "status-dot disconnected";
  if (DOM.statusText) DOM.statusText.textContent = "Déconnecté";
  if (DOM.btnSend) DOM.btnSend.disabled = true;
  addSystem("Déconnecté du serveur");
});
socket.on("agent-output", rawText => {
  const now = Date.now();
  for (const line of rawText.split("\n")) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    if (cleaned === lastLineText && now - lastLineTime < 1000) continue;
    lastLineText = cleaned; lastLineTime = now;
    if (isStartupBanner(cleaned)) continue;
    if (handleAgentQuestion(cleaned)) continue;
    if (captureSessionInfo(cleaned)) continue;
    const c = classifyMessage(cleaned);
    if (!c) continue;
    if (c.type === "error") addError(c.content);
    else if (c.type === "tool") addActivity(c.tool, c.target, c.status);
    else if (c.type === "success") addActivity(null, c.content, "success");
    else if (c.type === "system") addSystem(c.content);
    else if (c.type === "assistant") addAssistant(c.content);
  }
});
socket.on("agent-exited", code => { addError(`Agent terminé (code : ${code})`); addSystem(`Agent terminé (code : ${code})`); });

// ---------- Saisie ----------
const LOCAL_ONLY_COMMANDS = new Set(["/help", "/status", "/keys", "/model", "/auto", "/clear"]);
function sendMessage() {
  const text = (DOM.input?.value || "").trim();
  if (!text || !AppState.isConnected) return;
  DOM.input.value = ""; DOM.input.style.height = "auto";
  if (text.startsWith("/")) {
    if (!LOCAL_ONLY_COMMANDS.has(text)) addUser(text); // envoyé à l'agent (ex: /workspace, /exit) : garde une trace visible
    handleSlashCommand(text);
  } else {
    addUser(text);
    socket.emit("user-input", text);
  }
}
on("btn-send", "click", sendMessage);
on("user-input", "keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
on("user-input", "input", () => { DOM.input.style.height = "auto"; DOM.input.style.height = Math.min(DOM.input.scrollHeight, 150) + "px"; });
document.querySelectorAll(".btn-action").forEach(b => b.addEventListener("click", () => handleSlashCommand(b.dataset.command)));
on("btn-restart", "click", () => { socket.emit("restart-agent"); addSystem("Redémarrage de l'agent..."); });
on("btn-clear", "click", () => { if (DOM.chat) DOM.chat.innerHTML = ""; AppState.lastChatRole = null; lastAssistantDiv = null; });

// ---------- Init ----------
updateBadge(DOM.badgeActivity, 0);
updateBadge(DOM.badgeErrors, 0);
addSystem("Connecté à Khorgo — Interface Web");
addSystem("Tape /help ou utilise les boutons pour ouvrir les onglets.");
if (DOM.input) DOM.input.focus();

// ============================================================================
// 🎨 COLORATION SYNTAXIQUE (CSS inclus)
// ============================================================================
(function () {
  try {
    const ta = document.getElementById("editor-content");
    if (!ta) { console.warn("[highlight] #editor-content introuvable — panneau éditeur absent du DOM ?"); return; }
    if (ta.dataset.hlReady) return;
    ta.dataset.hlReady = "1";

    // Limite de taille : au-delà, on n'active pas la coloration (perf) mais
    // le textarea reste 100% utilisable en texte brut.
    const MAX_HIGHLIGHT_SIZE = 400000; // ~400 Ko

    const style = document.createElement("style");
    style.textContent = `
      .editor-wrap{position:relative!important;flex:1!important;overflow:hidden!important;background:#1a1a1a!important;display:block!important;}
      .editor-wrap .editor-content,.editor-wrap .editor-highlight{position:absolute!important;inset:0!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;margin:0!important;padding:14px!important;font-family:Consolas,'Courier New',monospace!important;font-size:13px!important;line-height:1.5!important;tab-size:2!important;white-space:pre!important;overflow:auto!important;border:none!important;box-sizing:border-box!important;}
      .editor-wrap .editor-highlight{pointer-events:none!important;overflow:hidden!important;background:transparent!important;z-index:1!important;margin:0!important;}
      .editor-wrap .editor-highlight code{font:inherit!important;display:block!important;background:transparent!important;color:#d4d4d4!important;}
      .editor-wrap .editor-content{background:transparent!important;caret-color:#fff!important;resize:none!important;outline:none!important;z-index:2!important;flex:none!important;max-height:none!important;}
      .editor-wrap .editor-content::placeholder{color:#808080;}
      .editor-wrap .editor-content::selection{background:rgba(237,237,236,.22);}
      .tok-comment{color:#6E6E6B;font-style:italic}.tok-string{color:#C9C9C6}.tok-keyword{color:#F2F2F0;font-weight:600}
      .tok-control{color:#DADAD7;font-weight:600}.tok-literal{color:#F2F2F0}.tok-number{color:#B7B7B4}
      .tok-func{color:#DCDCDA}.tok-tag{color:#F2F2F0}.tok-attr{color:#B7B7B4}.tok-prop{color:#B7B7B4}
    `;
    document.head.appendChild(style);

    // Rattache le textarea à un wrapper dédié, quelle que soit sa structure
    // actuelle dans le DOM (on ne suppose rien sur le parent existant).
    let wrap = ta.parentElement;
    if (!wrap || !wrap.classList.contains("editor-wrap")) {
      wrap = document.createElement("div");
      wrap.className = "editor-wrap";
      ta.parentNode.insertBefore(wrap, ta);
    }
    if (ta.parentNode !== wrap) wrap.appendChild(ta);

    let pre = wrap.querySelector(".editor-highlight");
    let codeEl;
    if (!pre) {
      pre = document.createElement("pre");
      pre.className = "editor-highlight";
      codeEl = document.createElement("code");
      pre.appendChild(codeEl);
      wrap.insertBefore(pre, ta);
    } else {
      codeEl = pre.querySelector("code") || pre;
    }

    // Styles critiques posés directement en JS (!important) : garantit le
    // bon rendu même si la feuille de style ci-dessus ne matche pas pour une
    // raison quelconque (ordre de chargement, doublon d'ID, etc.).
    function forceStyle(node, props) {
      for (const k in props) node.style.setProperty(k, props[k], "important");
    }
    forceStyle(wrap, { position: "relative", overflow: "hidden", background: "#1a1a1a" });
    forceStyle(pre, { position: "absolute", inset: "0", margin: "0", padding: "14px",
      "font-family": "Consolas,'Courier New',monospace", "font-size": "13px", "line-height": "1.5",
      "tab-size": "2", "white-space": "pre", overflow: "hidden", "pointer-events": "none",
      background: "transparent", "z-index": "1" });
    forceStyle(ta, { position: "absolute", inset: "0", margin: "0", padding: "14px",
      "font-family": "Consolas,'Courier New',monospace", "font-size": "13px", "line-height": "1.5",
      "tab-size": "2", "white-space": "pre", overflow: "auto", border: "none",
      background: "transparent", color: "transparent", "caret-color": "#fff", "z-index": "2" });

    function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  const RULES = {
    js: {
      regex: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|class|extends|new|require|module|exports|import|from|return|typeof|instanceof|delete|void|yield|async|await|static|get|set|switch|case|default|break|continue|throw|try|catch|finally|if|else|for|while|do|in|of)\b|\b(true|false|null|undefined|NaN|Infinity)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*(?=\s*\())/g,
      classes: ["tok-comment", "tok-string", "tok-keyword", "tok-literal", "tok-number", "tok-func"]
    },
    json: {
      regex: /("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      classes: ["tok-prop", "tok-string", "tok-literal", "tok-number"]
    },
    html: {
      regex: /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][^<>]*\/?>)|("[^"]*"|'[^']*')/g,
      classes: ["tok-comment", "tok-tag", "tok-string"]
    },
    css: {
      regex: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[\w-]+)|(#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms)?\b)|([a-zA-Z-]+(?=\s*:))/g,
      classes: ["tok-comment", "tok-string", "tok-keyword", "tok-number", "tok-prop"]
    }
  };

  function langFromPath(p) {
    const ext = ((p || "").split(".").pop() || "").toLowerCase();
    if (["js", "mjs", "cjs", "ts"].includes(ext)) return "js";
    if (ext === "json") return "json";
    if (["html", "htm", "xml", "vue"].includes(ext)) return "html";
    if (ext === "css") return "css";
    return null;
  }

  function highlight(code, lang) {
    const r = RULES[lang];
    if (!r) return esc(code);
    let out = "", last = 0, m;
    r.regex.lastIndex = 0;
    while ((m = r.regex.exec(code))) {
      if (m.index > last) out += esc(code.slice(last, m.index));
      let cls = "";
      for (let i = 1; i < m.length; i++) { if (m[i] !== undefined) { cls = r.classes[i - 1]; break; } }
      out += '<span class="' + cls + '">' + esc(m[0]) + "</span>";
      last = m.index + m[0].length;
      if (m[0].length === 0) r.regex.lastIndex++;
    }
    return out + esc(code.slice(last));
  }

    function showPlainFallback() {
      // Aucun calque noir orphelin : soit le pre est à jour, soit il est
      // masqué et le textarea redevient lisible en texte brut.
      pre.style.display = "none";
      ta.style.setProperty("color", "#d4d4d4", "important");
    }

    function update() {
      try {
        if (ta.value.length > MAX_HIGHLIGHT_SIZE) {
          showPlainFallback();
          return;
        }
        const pathEl = document.getElementById("editor-filepath");
        const lang = langFromPath(pathEl ? pathEl.textContent : (AppState && AppState.editorFile) || "");
        codeEl.innerHTML = highlight(ta.value, lang) + "\n";
        pre.style.display = "block";
        ta.style.setProperty("color", "transparent", "important");
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
      } catch (e) {
        console.error("[highlight] échec de la coloration, retour en texte brut :", e);
        showPlainFallback();
      }
    }

    ta.addEventListener("scroll", () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
    let t = null;
    ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(update, 120); });
    socket.on("file-content", (d) => { if (!d.error) setTimeout(update, 0); });
    update();
  } catch (e) {
    console.error("[highlight] initialisation impossible :", e);
  }
})();

function parseKhorgoError(rawInput) {
let code = null;
let status = "";
let rawMessage = "";

try {
const parsed = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
const errObj = parsed.error || parsed;
code = errObj.code || errObj.status_code;
status = errObj.status || "";
rawMessage = errObj.message || "";
} catch (e) {
rawMessage = String(rawInput);
}

// 1. Modèle non trouvé ou obsolète (Code 404 / NOT_FOUND)
if (code === 404 || status === "NOT_FOUND" || rawMessage.includes("no longer available")) {
return "Le modèle sélectionné n'est plus disponible ou a été mis à jour par le fournisseur. Veuillez choisir un autre modèle via le bouton Modèle ci-dessous.";
}

// 2. Clé API invalide ou absente (Code 401 / 403 / UNAUTHENTICATED)
if (code === 401 || code === 403 || status === "UNAUTHENTICATED" || rawMessage.includes("API key")) {
return "La clé API configurée est invalide ou expirée. Veuillez vérifier vos accès dans l'onglet Clés API.";
}

// 3. Quota ou limite de requêtes dépassée (Code 429 / RESOURCE_EXHAUSTED)
if (code === 429 || status === "RESOURCE_EXHAUSTED" || rawMessage.includes("quota")) {
return "La limite de requêtes ou le quota de votre compte a été atteint. Veuillez patienter quelques instants ou vérifier la formule de votre compte.";
}

// 4. Erreur serveur du fournisseur (Code 500 / 503 / INTERNAL)
if (code >= 500 || status === "INTERNAL" || status === "UNAVAILABLE") {
return "Le service d'IA rencontre des difficultés temporaires. Veuillez réessayer dans quelques instants.";
}

// 5. Erreur de connexion réseau
if (rawMessage.includes("Failed to fetch") || rawMessage.includes("NetworkError")) {
return "Impossible de contacter le serveur. Vérifiez votre connexion internet puis réessayez.";
}

// Message générique par défaut si l'erreur est inconnue
return rawMessage || "Une erreur inattendue est survenue. Veuillez réessayer.";
}

// ==============================
// renderKhorgoErrorCard
// ==============================
// Construit le HTML de la carte d'erreur (icône + message nettoyé + croix
// de fermeture), au format des bulles .message.error déjà stylées dans
// style.css — pas une nouvelle charte, juste le markup qui manquait.
function renderKhorgoErrorCard(rawInput) {
  const cleanMessage = parseKhorgoError(rawInput);
  return `<div class="message error">
    <div class="error-icon"><svg class="icon"><use href="#i-alert"/></svg></div>
    <div class="error-content">${escapeHtml(cleanMessage)}</div>
    <button type="button" class="khorgo-error-close" aria-label="Fermer" title="Fermer">
      <svg class="icon"><use href="#i-x"/></svg>
    </button>
  </div>`;
}

// ==============================
// addErrorCard
// ==============================
// Affiche une carte d'erreur propre dans le fil de discussion (DOM.chat),
// à la place du JSON brut renvoyé par l'API du fournisseur. Suit le même
// contrat que addAssistant()/addSystem() (arrêt du spinner "thinking",
// scroll auto, mise à jour de lastChatRole).
function addErrorCard(rawInput) {
  if (!DOM.chat) return;
  removeThinking();
  const div = document.createElement("div");
  div.innerHTML = renderKhorgoErrorCard(rawInput);
  const card = div.firstElementChild;
  card.querySelector(".khorgo-error-close").addEventListener("click", () => card.remove());
  DOM.chat.appendChild(card);
  AppState.lastChatRole = "error";
  lastAssistantDiv = null;
  DOM.chat.scrollTop = DOM.chat.scrollHeight;
}