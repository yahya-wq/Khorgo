const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const stripAnsi = require("strip-ansi");
const keyStore = require("./keyStore");
const { getAvailableProviders, getAvailableModels } = require("./modelManager");

const PORT = process.env.PORT || 3000;

// 🔒 SÉCURITÉ : par défaut, Socket.IO accepte les connexions WebSocket
// depuis N'IMPORTE QUELLE origine (aucune vérification de l'en-tête Origin).
// Combiné aux handlers read-file/write-file/list-dir plus bas (qui donnaient
// un accès disque total), n'importe quel site ouvert dans le même navigateur
// pendant que khorgo tourne pouvait ouvrir une connexion vers
// ws://localhost:3000 et lire/écrire n'importe quel fichier de la machine,
// sans aucune interaction de l'utilisateur (cross-site WebSocket hijacking).
// On n'accepte donc que les connexions dont l'en-tête Origin correspond à
// l'app elle-même (localhost/127.0.0.1 sur le port du serveur), ou l'absence
// totale d'en-tête Origin (cas des clients non-navigateur / requêtes locales
// directes, qui n'envoient pas cet en-tête).
function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const { hostname, port } = new URL(origin);
    const effectivePort = port || "80";
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";
    return isLocalHost && effectivePort === String(PORT);
  } catch {
    return false;
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  allowRequest: (req, callback) => {
    const allowed = isAllowedOrigin(req.headers.origin);
    callback(allowed ? null : "Origin non autorisée", allowed);
  }
});
app.use(express.static(path.join(__dirname, "public")));

let agentProcess = null;
let clientSocket = null;
let agentWorkspace = null;   // dossier de l'agent, détecté depuis ses logs
let stdoutBuffer = "";
const sessionConfig = { provider: null, modelId: null };

function emitToClient(event, payload) {
  if (clientSocket) clientSocket.emit(event, payload);
}

// 🔒 SÉCURITÉ : les handlers list-dir / read-file / write-file utilisaient
// directement le filePath/dirPath envoyé par le client, sans AUCUNE
// vérification — contrairement à safePath() dans agent.js. N'importe quel
// client connecté au socket pouvait donc lire ou écrire n'importe quel
// fichier accessible au process Node (ex: filePath: "C:\\Users\\...\\.ssh\\id_rsa"),
// bien au-delà du dossier de travail de l'agent. Cette fonction reproduit
// la même logique de sandbox que safePath() dans agent.js (résolution des
// symlinks y compris sur un chemin qui n'existe pas encore, interdiction de
// sortir du workspace, interdiction d'atteindre le code source interne de
// l'agent), pour que l'éditeur web soit soumis aux mêmes règles que l'agent.
const PROTECTED_TOP_LEVEL = new Set([
  "agent.js",
  "modelManager.js",
  "keystore.js",
  "server.js",
  ".env",
  "package.json",
  "package-lock.json",
  "node_modules",
  ".git"
]);

function getWorkspaceRoot() {
  return agentWorkspace || process.cwd();
}

function safeWorkspacePath(inputPath) {
  const root = path.resolve(getWorkspaceRoot());
  const absolutePath = path.resolve(root, inputPath);

  let existingAncestor = absolutePath;
  let remainder = "";

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break; // racine du filesystem atteinte
    remainder = path.join(path.basename(existingAncestor), remainder);
    existingAncestor = parent;
  }

  const resolvedAncestor = fs.realpathSync(existingAncestor);
  const fullPath = remainder ? path.join(resolvedAncestor, remainder) : resolvedAncestor;
  const resolvedRoot = fs.realpathSync(root);

  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Accès refusé hors de l'espace de travail : ${inputPath}`);
  }

  const relativePath = path.relative(resolvedRoot, fullPath);
  const topLevel = (relativePath.split(path.sep)[0] || "").toLowerCase();

  if (PROTECTED_TOP_LEVEL.has(topLevel)) {
    throw new Error(`Accès refusé : '${topLevel}' fait partie du code source interne de l'agent.`);
  }

  return fullPath;
}

// Collapse les redraws de spinner (ex: ora) qui utilisent \r pour réécrire
// une même ligne : ne garde que la dernière version de chaque ligne.
function collapseCarriageReturns(str) {
  return str
    .split("\n")
    .map((line) => {
      const idx = line.lastIndexOf("\r");
      return idx === -1 ? line : line.slice(idx + 1);
    })
    .join("\n");
}

// Lignes techniques/publicitaires à ne pas afficher dans le chat
// (ex: bandeau dotenvx, résidus de spinner Braille après strip-ansi).
function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return false; // ligne vide : on la garde, elle sert à l'espacement visuel
  if (/dotenvx/i.test(t)) return true;
  if (/injected env/i.test(t)) return true;
  if (/suppress logs/i.test(t)) return true;
  if (/^[^\w\s]{1,3}$/.test(t)) return true; // ligne composée uniquement de symboles isolés
  return false;
}

function stripNoise(text) {
  return text
    .split("\n")
    .map((line) => stripAnsi(line))
    .filter((line) => !isNoiseLine(line))
    .join("\n");
}

// Détecte le dossier de travail de l'agent sans modifier agent.js
function detectWorkspace(line) {
  const m = line.match(/(?:Workspace|Dossier de travail|Dossier créé et sélectionné)\s*:\s*(.+)/);
  if (m) {
    agentWorkspace = m[1].trim();
    emitToClient("workspace-detected", agentWorkspace);
  }
}

function startAgent() {
  if (agentProcess) return;
  // KHORGO_WEB=1 : signale à agent.js qu'il tourne sous l'app web (et non
  // en CLI pure), pour qu'il saute son menu ASCII interactif "CHOISIR UN
  // FOURNISSEUR" au démarrage (déjà remplacé par la fenêtre 🧠 Modèle côté
  // navigateur). Toujours défini : server.js ne lance agent.js que depuis
  // l'app web désormais.
  const env = { ...process.env, FORCE_COLOR: "0", KHORGO_WEB: "1" };
  if (sessionConfig.provider) env.KHORGO_PROVIDER = sessionConfig.provider;
  if (sessionConfig.modelId) env.KHORGO_MODEL = sessionConfig.modelId;

  agentProcess = spawn("node", ["agent.js"], {
    cwd: __dirname, env,
    stdio: ["pipe", "pipe", "pipe", "ipc"]
  });

  agentProcess.stdout.on("data", (d) => {
    const raw = collapseCarriageReturns(d.toString());
    stdoutBuffer += raw;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) detectWorkspace(stripAnsi(line));
    const cleaned = stripNoise(raw);
    if (cleaned.trim()) emitToClient("agent-output", cleaned);
  });

  agentProcess.stderr.on("data", (d) => emitToClient("agent-output", "[ERREUR] " + stripAnsi(d.toString())));

  // Canal IPC structuré (process.send côté agent.js, voir emitStructured()).
  // 🔴 CORRECTION : ce handler ne reconnaissait que msg.type === "log" / "error"
  // (jamais envoyés sous cette forme par agent.js) et lisait `msg.message`
  // alors que agent.js envoie `msg.text`. Résultat : en mode web, TOUS les
  // messages structurés (réponses de l'IA, erreurs, avertissements, notices,
  // statut de session, activité des outils) étaient silencieusement perdus —
  // rien n'arrivait jamais côté client. On traduit maintenant chaque type
  // vers un événement socket dédié, écouté par app.js.
  agentProcess.on("message", (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "assistant":
        emitToClient("agent-assistant", { text: stripAnsi(msg.text || "") });
        break;

      case "tool":
        emitToClient("agent-tool", {
          tool: msg.tool,
          target: stripAnsi(msg.target || ""),
          status: msg.status
        });
        break;

      case "error":
        emitToClient("agent-error", { text: stripAnsi(msg.text || "") });
        break;

      case "warning":
        emitToClient("agent-warning", { text: stripAnsi(msg.text || "") });
        break;

      case "notice":
        emitToClient("agent-notice", { text: stripAnsi(msg.text || "") });
        break;

      case "status":
        // msg peut ne contenir qu'un sous-ensemble des champs (workspace,
        // provider, model, autoAccept) : on transmet tel quel, app.js ne
        // met à jour que ce qui est présent.
        emitToClient("agent-status", msg);
        break;

      case "thinking":
        emitToClient("agent-thinking", { active: !!msg.active });
        break;

      default:
        // Type inconnu : on ignore plutôt que de planter le serveur.
        break;
    }
  });
  agentProcess.on("close", (code) => {
    emitToClient("agent-thinking", { active: false });
    emitToClient("agent-exited", code);
    agentProcess = null;
  });
  agentProcess.on("error", (err) => emitToClient("agent-output", "❌ Erreur agent : " + err.message));
}

function restartAgent() {
  if (agentProcess) { agentProcess.removeAllListeners(); agentProcess.kill(); agentProcess = null; }
  setTimeout(startAgent, 400);
}

io.on("connection", (socket) => {
  clientSocket = socket;
  if (!agentProcess) startAgent();

  socket.on("user-input", (message) => {
    if (agentProcess && agentProcess.stdin.writable) agentProcess.stdin.write(message + "\n");
    else socket.emit("agent-output", "❌ L'agent n'est pas disponible.");
  });

  socket.on("restart-agent", () => restartAgent());

  // ---- /keys ----
  socket.on("get-keys", async () => {
    try { socket.emit("keys-status", await keyStore.listConfiguredKeys()); }
    catch (e) { socket.emit("keys-status", []); }
  });
  socket.on("set-key", async ({ provider, key }) => {
    try {
      await keyStore.setKey(provider, key);
      socket.emit("keys-status", await keyStore.listConfiguredKeys());
      socket.emit("agent-output", "🔄 Clé enregistrée. Redémarrage de l'agent…");
      restartAgent();
    } catch (e) { socket.emit("agent-output", "❌ " + e.message); }
  });
  socket.on("delete-key", async ({ provider }) => {
    try {
      await keyStore.deleteKey(provider);
      // Si la clé supprimée est celle du provider actuellement sélectionné,
      // on réinitialise sessionConfig : sinon agent.js redémarre avec
      // KHORGO_PROVIDER pointant vers un provider maintenant non configuré.
      // (agent.js sait désormais retomber automatiquement sur un provider
      // disponible dans ce cas, mais autant repartir d'un état propre.)
      if (sessionConfig.provider === provider) {
        sessionConfig.provider = null;
        sessionConfig.modelId = null;
      }
      socket.emit("keys-status", await keyStore.listConfiguredKeys());
      socket.emit("agent-output", "🔄 Clé supprimée. Redémarrage de l'agent…");
      restartAgent();
    } catch (e) { socket.emit("agent-output", "❌ " + e.message); }
  });

  // ---- /model ----
  socket.on("get-providers", () => socket.emit("providers-list", getAvailableProviders()));
  socket.on("get-models", async ({ providerId }) => {
    try { socket.emit("models-list", { models: await getAvailableModels(providerId), error: null }); }
    catch (e) { socket.emit("models-list", { models: [], error: e.message }); }
  });
  socket.on("select-model", ({ providerId, modelId }) => {
    sessionConfig.provider = providerId;
    sessionConfig.modelId = modelId;
    socket.emit("agent-output", "🔄 Modèle sélectionné. Redémarrage de l'agent…");
    restartAgent();
  });

  // ---- 💻 ÉDITEUR DE CODE ----
  socket.on("list-dir", ({ dirPath } = {}) => {
    let base;
    try {
      base = dirPath ? safeWorkspacePath(dirPath) : path.resolve(getWorkspaceRoot());
      const entries = fs.readdirSync(base, { withFileTypes: true })
        .filter(e => e.name !== "node_modules" && e.name !== ".git")
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : "file", path: path.join(base, e.name) }));
      socket.emit("dir-list", { path: base, entries, error: null });
    } catch (e) {
      socket.emit("dir-list", { path: dirPath || base || "", entries: [], error: e.message });
    }
  });

  socket.on("read-file", ({ filePath }) => {
    try {
      const safePath = safeWorkspacePath(filePath);
      const stat = fs.statSync(safePath);
      if (stat.size > 1024 * 1024) return socket.emit("file-content", { filePath, error: "Fichier trop lourd (> 1 Mo)." });
      const content = fs.readFileSync(safePath, "utf8");
      if (content.indexOf("\0") !== -1) return socket.emit("file-content", { filePath, error: "Fichier binaire : non éditable." });
      socket.emit("file-content", { filePath, content, error: null });
    } catch (e) {
      socket.emit("file-content", { filePath, error: e.message });
    }
  });

  socket.on("write-file", ({ filePath, content }) => {
    try {
      const safePath = safeWorkspacePath(filePath);
      fs.writeFileSync(safePath, content, "utf8");
      socket.emit("file-saved", { filePath, ok: true });
    } catch (e) {
      socket.emit("file-saved", { filePath, ok: false, error: e.message });
    }
  });

  socket.on("disconnect", () => { if (clientSocket === socket) clientSocket = null; });
});

// 🔒 SÉCURITÉ : sans hôte explicite, Node écoute par défaut sur toutes les
// interfaces réseau (0.0.0.0) — le serveur serait donc joignable depuis
// n'importe quelle machine du même réseau local (Wi-Fi public, etc.), pas
// seulement depuis la machine de l'utilisateur. On restreint à 127.0.0.1.
keyStore.loadAllKeysIntoEnv().catch(() => {}).finally(() => {
  server.listen(PORT, "127.0.0.1", () => console.log(`🌐 Serveur sur http://localhost:${PORT}`));
});
process.on("SIGINT", () => { if (agentProcess) agentProcess.kill(); process.exit(0); });