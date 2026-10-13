#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

// Nouvelles dépendances UI
const chalk = require("chalk");
const ora = require("ora");

const OpenAI = require("openai");
const { getModel, getAvailableProviders, getAvailableModels, hasApiKey } = require("./modelManager");
const keyStore = require("./keyStore");

let WORKSPACE = process.cwd();

// Mode web : l'agent est piloté par server.js (interface graphique), donc
// tous les menus interactifs texte redondants avec les fenêtres modales
// du navigateur doivent être évités.
const WEB_MODE = process.env.KHORGO_WEB === "1";

// ora() écrit ses frames d'animation sur stderr par défaut. En mode web,
// server.js traite tout stderr comme une vraie erreur ("[ERREUR] ...") —
// donc un spinner purement décoratif ("L'agent réfléchit...") apparaissait
// à tort comme une erreur à chaque tour. sayThinking()/sayTool() remplissent
// déjà ce rôle proprement via le canal IPC structuré : le spinner ora ne
// sert donc plus qu'en CLI pure (WEB_MODE = false).
function spin(text) {
  if (WEB_MODE) return { stop() {}, succeed() {}, fail() {} };
  return ora(chalk.cyan(text)).start();
}

// ==============================
// FICHIERS PROTÉGÉS (Invisibles pour l'agent)
// ==============================
const PROTECTED_FILES = new Set([
  "agent.js",
  "modelManager.js",
  "models.js",
  "keyStore.js",
  ".env",
  "package.json",
  "package-lock.json",
  "node_modules",
  ".git"
]);

// ==============================
// SORTIE STRUCTURÉE (web) vs TERMINAL (CLI)
// ==============================
// AVANT : toute la sortie de l'agent passait par console.log() en texte
// libre (emojis, couleurs), et server.js/app.js devaient RE-DEVINER le
// sens de chaque ligne après coup via des regex (classifyMessage() côté
// client). C'est fragile par construction : une reformulation anodine
// cassait le routage, et il fallait même une fonction dédiée plus bas
// (neutralizeProtocolMarkers) pour empêcher le texte généré par l'IA de
// collisionner avec les marqueurs de protocole eux-mêmes (✅ / ❌ / "Confirmer ?").
//
// MAINTENANT : en mode web (KHORGO_WEB=1), chaque catégorie de sortie part
// vers server.js sous forme d'événement STRUCTURÉ ({type, ...}) via le
// canal IPC (process.send) — ce canal existait déjà côté server.js
// (agentProcess.on("message")) mais n'était jamais utilisé côté agent :
// tout partait quand même en texte brut sur stdout. Le rendu CLI (npm run
// agent, hors interface web) reste identique caractère pour caractère.
//
// Portée de cette migration : les catégories à fort enjeu — réponses de
// l'IA, activité des outils, erreurs, avertissements, statut de session —
// passent maintenant par ce canal. Les questions de confirmation
// ([o/n/t], choix de dossier) restent pour l'instant sur le canal texte
// existant (déjà durci par neutralizeProtocolMarkers) : les migrer aussi
// demanderait de changer le mécanisme de réponse (pas seulement l'affichage
// de la question), ce qui est un chantier à part.
function emitStructured(type, payload = {}) {
  if (WEB_MODE && typeof process.send === "function") {
    try {
      process.send({ type, ...payload });
    } catch {
      // Canal IPC fermé (process parent en train de se terminer) : sans
      // conséquence pour l'agent lui-même, on ignore.
    }
  }
}

// Réponse texte de l'IA — c'était le cas par défaut de classifyMessage()
// côté client (aucun marqueur reconnu ne tombe ici), donc le plus fragile :
// n'importe quelle ligne système non reconnue finissait affichée comme si
// l'IA l'avait dite (c'est ce qui causait la bannière de démarrage affichée
// en bulle "assistant").
function sayAssistant(text) {
  const safe = text || "(aucun texte)";
  if (WEB_MODE) emitStructured("assistant", { text: safe });
  else console.log(safe);
}

function sayError(text) {
  if (WEB_MODE) emitStructured("error", { text });
  else console.log(chalk.red(`❌ ${text}`));
}

function sayWarning(text) {
  if (WEB_MODE) emitStructured("warning", { text });
  else console.log(text);
}

// Indicateur "l'agent réfléchit" — actif entre l'envoi de la requête au
// modèle et la réception de sa réponse (y compris pendant les retries de
// callWithRetry). En web, remplace le besoin de deviner cet état depuis le
// spinner CLI (qui n'était de toute façon jamais transmis au client).
function sayThinking(active) {
  if (WEB_MODE) emitStructured("thinking", { active });
}

// Notice système ponctuelle et neutre (ni réponse de l'IA, ni erreur).
function sayNotice(text) {
  if (WEB_MODE) emitStructured("notice", { text });
  else console.log(text);
}

// Statut de session structuré — remplace le parsing de lignes
// "Workspace : x" / "Provider : y" par captureSessionInfo() côté client.
// N'importe quel champ omis est laissé tel quel côté UI.
function sayStatus(status) {
  if (WEB_MODE) emitStructured("status", status || {});
}

// Activité d'un outil (Read/Write/Edit/Explore/Search/Command).
// En CLI, garde le formatage coloré existant (formatToolLog, défini plus
// bas) ; en web, envoie directement les champs structurés au lieu de
// forcer le client à les extraire d'une chaîne formatée avec des regex.
function sayTool(toolName, args, status) {
  if (WEB_MODE) {
    const labels = {
      write_file: "Write", edit_file: "Edit", read_file: "Read",
      list_files: "Explore", search_files: "Search", run_command: "Command"
    };
    const tool = labels[toolName] || toolName;
    const target = args.filePath || args.command || args.directory || args.pattern || "";
    emitStructured("tool", { tool, target, status });
  } else {
    console.log(formatToolLog(toolName, args, status));
  }
}


// Encapsule un appel API pour retenter automatiquement en cas d'erreur
// transitoire (rate-limit, erreur serveur, coupure réseau), au lieu de
// faire échouer toute la tâche en cours pour un problème temporaire.
// 🔴 CORRECTION : cette fonction était définie DEUX FOIS dans le fichier
// d'origine (la seconde définition écrasait silencieusement la première,
// qui contenait le message spécifique pour le code 429). Fusionnée ici
// en une seule version qui garde les deux comportements.

async function callWithRetry(fn, { maxRetries = 3, baseDelayMs = 1000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const status = error.status || error.response?.status;

      const isRetryable =
        status === 429 ||
        status === 500 ||
        status === 503 ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNRESET";

      if (!isRetryable || attempt === maxRetries) {
        if (status === 429) {
          sayError("💳 Tu n'as plus de crédit (ou limite de requêtes atteinte).");
        }
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s...
      sayNotice(`⏳ Erreur temporaire (${status || error.code}), nouvelle tentative dans ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function safePath(filePath) {
  const absolutePath = path.resolve(WORKSPACE, filePath);

  // 🔴 Trouver le premier ancêtre qui existe réellement, pour pouvoir
  // résoudre les symlinks même quand le fichier/dossier final n'existe pas encore.
  let existingAncestor = absolutePath;
  let remainder = ""; // partie du chemin qui n'existe pas encore (ex: "sousdossier/nouveau.txt")

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);

    if (parent === existingAncestor) {
      // On a atteint la racine du filesystem sans rien trouver : cas anormal.
      break;
    }

    remainder = path.join(path.basename(existingAncestor), remainder);
    existingAncestor = parent;
  }

  // Résoudre les symlinks sur la partie qui existe réellement
  const resolvedAncestor = fs.realpathSync(existingAncestor);

  // Recomposer le chemin final avec la partie qui n'existe pas encore
  const fullPath = remainder
    ? path.join(resolvedAncestor, remainder)
    : resolvedAncestor;

  // Vérification 1 : Ne pas sortir du dossier de travail (sur le vrai chemin résolu)
  if (fullPath !== WORKSPACE && !fullPath.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Accès refusé hors de l'espace de travail : ${filePath}`);
  }

  // Vérification 2 : Bloquer l'accès au code source de l'agent (insensible à la casse)
  const relativePath = path.relative(WORKSPACE, fullPath);
  const topLevelEntity = relativePath.split(path.sep)[0].toLowerCase();

  const protectedLower = new Set([...PROTECTED_FILES].map(f => f.toLowerCase()));

  if (protectedLower.has(topLevelEntity)) {
    throw new Error(`Accès refusé : '${topLevelEntity}' fait partie de mon code source interne.`);
  }

  return fullPath;
}

// 🔴 AJOUT : helper réutilisé par listFiles et searchFiles
function isWithinWorkspace(fullPath) {
  let resolved = fullPath;
  try {
    resolved = fs.realpathSync(fullPath);
  } catch {
    return true; // n'existe pas (ou lien cassé) : rien à résoudre, pas bloquant ici
  }
  return resolved === WORKSPACE || resolved.startsWith(WORKSPACE + path.sep);
}

// ==============================
// OUTILS
// ==============================

function readFile(filePath, startLine, endLine) {
  const fullPath = safePath(filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Fichier introuvable : ${filePath}`);
  }

  const content = fs.readFileSync(fullPath, "utf8");

  // Si des lignes spécifiques sont demandées, on découpe le contenu
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n');
    const start = startLine ? Math.max(1, startLine) - 1 : 0;
    const end = endLine ? Math.min(lines.length, endLine) : lines.length;
    return lines.slice(start, end).join('\n');
  }

  return content;
}

function writeFile(filePath, content) {
  const fullPath = safePath(filePath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");

  return `Fichier écrit avec succès : ${filePath}`;
}

function editFile(filePath, oldStr, newStr) {
  const fullPath = safePath(filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Fichier introuvable : ${filePath}`);
  }

  const content = fs.readFileSync(fullPath, "utf8");

  if (!content.includes(oldStr)) {
    throw new Error(
      `Le texte à remplacer est introuvable dans ${filePath}. ` +
      `Vérifie qu'il correspond EXACTEMENT (espaces, indentation, sauts de ligne) ` +
      `au contenu du fichier — utilise read_file d'abord si besoin.`
    );
  }

  const occurrences = content.split(oldStr).length - 1;

  if (occurrences > 1) {
    throw new Error(
      `Le texte à remplacer apparaît ${occurrences} fois dans ${filePath}. ` +
      `Fournis un extrait plus long incluant du contexte autour pour cibler un seul endroit.`
    );
  }

  const updatedContent = content.replace(oldStr, newStr);

  fs.writeFileSync(fullPath, updatedContent, "utf8");

  return `Fichier modifié avec succès : ${filePath}`;
}

function listFiles(directory = ".") {
  const fullPath = safePath(directory);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Dossier introuvable : ${directory}`);
  }

  function explore(currentPath, relativePath) {
    const entries = fs.readdirSync(currentPath, {
      withFileTypes: true
    });

    let result = [];

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const entryRelativePath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        // Dossiers internes invisibles pour l'IA
        if (
          entry.name === "node_modules" ||
          entry.name === ".agent"
        ) {
          continue;
        }

        // 🔴 AJOUT : ignorer les symlinks qui pointent hors du workspace
        if (!isWithinWorkspace(entryPath)) {
          continue;
        }

        result.push({
          path: entryRelativePath,
          type: "directory"
        });

        result = result.concat(
          explore(entryPath, entryRelativePath)
        );
      } else {
        result.push({
          path: entryRelativePath,
          type: "file"
        });
      }
    }

    return result;
  }

  return explore(fullPath, directory);
}

const SEARCH_MAX_RESULTS = 100;

// 🔴 CORRECTION : dans le fichier d'origine, la branche "fichier" de la
// boucle contenait seulement le commentaire `// ... reste inchangé
// (lecture du fichier) ...` — aucun résultat n'était donc jamais poussé
// dans `results`, et `search_files` retournait systématiquement un
// tableau vide. Implémentation complète ci-dessous : lecture du fichier,
// test ligne par ligne avec le regex, et arrêt dès que la limite est
// atteinte.

function searchFiles(pattern, directory = ".") {
  const fullPath = safePath(directory);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Dossier introuvable : ${directory}`);
  }

  let regex;

  try {
    regex = new RegExp(pattern, "i");
  } catch {
    throw new Error(`Motif de recherche invalide : ${pattern}`);
  }

  const results = [];

  function explore(currentPath, relativePath) {
    if (results.length >= SEARCH_MAX_RESULTS) {
      return;
    }

    const entries = fs.readdirSync(currentPath, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (results.length >= SEARCH_MAX_RESULTS) {
        return;
      }

      const entryPath = path.join(currentPath, entry.name);
      const entryRelativePath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".agent" ||
          entry.name === ".git"
        ) {
          continue;
        }

        // 🔴 AJOUT : ignorer les symlinks qui pointent hors du workspace
        if (!isWithinWorkspace(entryPath)) {
          continue;
        }

        explore(entryPath, entryRelativePath);
        continue;
      }

      // Lecture et recherche ligne par ligne dans le fichier.
      // On ignore silencieusement les fichiers illisibles (binaires,
      // permissions, etc.) plutôt que de faire échouer toute la recherche.
      let content;
      try {
        content = fs.readFileSync(entryPath, "utf8");
      } catch {
        continue;
      }

      // Heuristique simple pour éviter de scanner des binaires : si le
      // contenu contient un octet nul, on considère que ce n'est pas du
      // texte et on passe au fichier suivant.
      if (content.indexOf("\0") !== -1) {
        continue;
      }

      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= SEARCH_MAX_RESULTS) {
          return;
        }

        if (regex.test(lines[i])) {
          results.push({
            file: entryRelativePath,
            line: i + 1,
            content: lines[i].trim()
          });
        }
      }
    }
  }

  explore(fullPath, directory);

  return results;
}

function formatSearchResults(pattern, matches) {
  if (matches.length === 0) {
    return `Aucun résultat pour "${pattern}".`;
  }

  const lines = matches.map(m => `${m.file}:${m.line}: ${m.content}`);

  let output = `${matches.length} résultat(s) pour "${pattern}" :\n\n${lines.join("\n")}`;

  if (matches.length >= SEARCH_MAX_RESULTS) {
    output += `\n\n️ Résultats limités à ${SEARCH_MAX_RESULTS} — affine ta recherche (motif plus précis ou sous-dossier) pour voir le reste.`;
  }

  return output;
}

// ==============================
// PERMISSIONS DES COMMANDES
// ==============================
// Système de filtrage simplifié : au lieu d'une liste noire trop restrictive,
// nous nous concentrons sur le blocage des commandes destructrices connues.

const ALLOWED_BASE_COMMANDS = [
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "pip",
  "git",
  "dir",
  "ls",
  "cd",
  "mkdir",
  "touch"
];

const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~|\.{1,2}(\/|$)|\*)/i,
  /format\b/i,
  /shutdown\b/i,
  /sudo\b/i,
  /runas\b/i,
  /invoke-expression|iex\b/i,
  />\s*\/dev\/(sd|null)/i,
  /curl.*\|\s*(sh|bash)/i,
  /wget.*\|\s*(sh|bash)/i
];

// Substitution de commande : bloquer backticks et $()
const COMMAND_SUBSTITUTION = /`|\$\(/;

// 🔴 AJOUT SÉCURITÉ : node/python/python3 sont dans ALLOWED_BASE_COMMANDS
// pour lancer des scripts DU PROJET (ex: "node build.js", "python test.py"),
// mais leurs flags d'exécution de code inline ("-e"/"--eval"/"-p"/"--print"
// pour node, "-c" pour python/python3) permettent d'exécuter n'importe quel
// code arbitraire — qui, lui, n'est PAS soumis à safePath()/PROTECTED_FILES.
// Sans ce garde-fou, "node -e \"require('fs').readFileSync('../../keyStore.js')\""
// (ou pire, en écriture) contourne complètement le bac à sable du workspace
// et la protection du code source de l'agent, tout en restant une commande
// "autorisée" au sens de la liste blanche ci-dessus.
const INLINE_EVAL_FLAGS = {
  node: [/^-e$/, /^--eval$/, /^-p$/, /^--print$/],
  python: [/^-c$/],
  python3: [/^-c$/]
};

function assertNoInlineEval(baseCommand, argTokens) {
  const flags = INLINE_EVAL_FLAGS[baseCommand];
  if (!flags) return;

  const hasEvalFlag = argTokens.some(token => flags.some(re => re.test(token)));

  if (hasEvalFlag) {
    throw new Error(
      `Commande refusée : l'exécution de code inline ("${baseCommand} -e/-c/--eval/-p") est bloquée ` +
      `car elle contourne le bac à sable du workspace (safePath) et l'accès aux fichiers protégés. ` +
      `Écris le code dans un fichier via write_file, puis exécute-le avec run_command ` +
      `(ex: "${baseCommand} script.js" / "${baseCommand} script.py").`
    );
  }
}

function assertSegmentAllowed(segment) {
  const trimmed = segment.trim();
  if (!trimmed) return;

  for (const blocked of BLOCKED_COMMAND_PATTERNS) {
    if (blocked.test(trimmed)) {
      throw new Error(`Commande refusée : motif interdit détecté (${blocked}) dans "${trimmed}".`);
    }
  }

  const tokens = trimmed.split(/\s+/);
  const baseCommand = tokens[0].toLowerCase();

  if (!ALLOWED_BASE_COMMANDS.includes(baseCommand)) {
    throw new Error(
      `Commande refusée : "${baseCommand}" n'est pas une commande autorisée. ` +
      `Commandes permises : ${ALLOWED_BASE_COMMANDS.join(", ")}.`
    );
  }

  assertNoInlineEval(baseCommand, tokens.slice(1));
}

function assertCommandAllowed(command) {
  const trimmed = command.trim();

  if (!trimmed) {
    throw new Error("Commande vide.");
  }

  if (COMMAND_SUBSTITUTION.test(trimmed)) {
    throw new Error(
      `Commande refusée : la substitution de commande (backticks ou $(...)) n'est pas autorisée.`
    );
  }

  // On découpe sur les opérateurs de chaînage (&&, ||, ;, |, &) et on
  // vérifie chaque segment individuellement, pour empêcher de glisser
  // une commande interdite après un enchaînement légitime.
  const segments = trimmed.split(/&&|\|\||;|\||&/);

  for (const segment of segments) {
    assertSegmentAllowed(segment);
  }
}

// 🔴 CORRECTION MAJEURE : dans le fichier d'origine, le corps de
// `runCommand` était remplacé par un bloc de code copié-collé depuis
// `runTaskOpenAI` (confirmation utilisateur, spinner, messages.push...).
// Ce bloc référençait des variables qui n'existent pas dans cette
// fonction (`toolName`, `args`, `toolCall`, `messages`, `state`) et
// n'exécutait donc jamais la commande — en plus de casser la syntaxe de
// tout le fichier (accolades non refermées). `execSync` était importé
// en haut du fichier mais jamais utilisé : c'est bien lui qu'il fallait
// appeler ici.

function runCommand(command) {
  assertCommandAllowed(command);

  try {
    const output = execSync(command, {
      cwd: WORKSPACE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    return output || "(commande terminée sans sortie)";
  } catch (error) {
    // execSync lève une exception si le code de sortie est non nul,
    // mais stdout/stderr restent disponibles sur l'objet d'erreur.
    const stdout = error.stdout ? error.stdout.toString() : "";
    const stderr = error.stderr ? error.stderr.toString() : "";

    throw new Error(
      `La commande a échoué (code ${error.status ?? "inconnu"}).\n` +
      (stdout ? `--- stdout ---\n${stdout}\n` : "") +
      (stderr ? `--- stderr ---\n${stderr}` : error.message)
    );
  }
}

// ==============================
// OUTILS DONNÉS À NEMOTRON
// ==============================

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Lit le contenu d'un fichier du projet. Utilise startLine et endLine pour lire une portion d'un gros fichier.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Chemin du fichier à lire." },
          startLine: { type: "number", description: "Ligne de départ (optionnel)." },
          endLine: { type: "number", description: "Ligne de fin (optionnel)." }
        },
        required: ["filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Crée un fichier ou remplace tout son contenu. Pour une petite modif, utilise plutôt edit_file.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Chemin du fichier."
          },
          content: {
            type: "string",
            description: "Contenu complet du fichier."
          }
        },
        required: ["filePath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Remplace un extrait exact et unique dans un fichier, sans le réécrire entièrement. " +
        "oldStr doit correspondre au caractère près (espaces/indentation) et n'apparaître qu'une fois — inclue du contexte si besoin.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Chemin du fichier à modifier."
          },
          oldStr: {
            type: "string",
            description: "Extrait exact à remplacer (doit apparaître une seule fois dans le fichier)."
          },
          newStr: {
            type: "string",
            description: "Nouveau texte qui remplace oldStr."
          }
        },
        required: ["filePath", "oldStr", "newStr"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Liste les fichiers et dossiers disponibles dans le projet.",
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Dossier à explorer. Utilise '.' pour le dossier du projet."
          }
        },
        required: ["directory"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Cherche un motif (texte ou regex) dans le projet, façon grep. Renvoie fichier:ligne + extrait. " +
        "Préfère cet outil à lire les fichiers un par un.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Texte ou expression régulière à rechercher (insensible à la casse)."
          },
          directory: {
            type: "string",
            description: "Dossier où chercher. Utilise '.' pour tout le projet."
          }
        },
        required: ["pattern", "directory"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Exécute une commande (node, npm, npx, python, python3, pip, git uniquement). " +
        "Le chaînage (; & | ` $ redirections) est bloqué.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Commande à exécuter, ex: \"npm install\", \"npm test\", \"git status\"."
          }
        },
        required: ["command"]
      }
    }
  }
];

// ==============================
// LIMITER LA TAILLE DES RÉSULTATS D'OUTILS
// ==============================
// Sans plafond, un gros fichier lu, une recherche large ou un `list_files`
// sur un gros dossier peuvent injecter des milliers de tokens dans
// l'historique. Comme tout l'historique est renvoyé à CHAQUE tour, ça
// ralentit chaque appel API suivant, même si le résultat n'était utile
// qu'une fois. On tronque donc systématiquement avant de le stocker.

const TOOL_RESULT_MAX_CHARS = 6000;

function truncateToolResult(text) {
  const str = String(text);

  if (str.length <= TOOL_RESULT_MAX_CHARS) {
    return str;
  }

  const cut = str.length - TOOL_RESULT_MAX_CHARS;

  return (
    str.slice(0, TOOL_RESULT_MAX_CHARS) +
    `\n\n… [tronqué, ${cut} caractères en plus] — affine ta requête (sous-dossier précis, motif plus spécifique, ou lis une portion du fichier) plutôt que de tout charger.`
  );
}

// ==============================
// EXÉCUTER UN OUTIL
// ==============================

function executeTool(name, args) {
  switch (name) {
    case "read_file":
      return readFile(args.filePath, args.startLine, args.endLine);
    case "write_file":
      return writeFile(args.filePath, args.content);
    case "edit_file":
      return editFile(args.filePath, args.oldStr, args.newStr);
    case "list_files": {
      const files = listFiles(args.directory);
      return JSON.stringify(files, null, 2);
    }
    case "search_files": {
      const matches = searchFiles(args.pattern, args.directory);
      return formatSearchResults(args.pattern, matches);
    }
    case "run_command":
      return runCommand(args.command);
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

// ==============================
// CONFIRMATION UTILISATEUR
// ==============================
// Les outils qui modifient le disque ou exécutent du code arbitraire
// doivent être approuvés par l'utilisateur avant d'être lancés, sauf
// en mode "auto-accept" (activé via /auto ou en répondant "t" à une
// confirmation).

const TOOLS_REQUIRING_CONFIRMATION = new Set([
  "write_file",
  "edit_file",
  "run_command"
]);

// app.js parse le flux texte de l'agent avec des règles fragiles : entre
// autres, il détecte la fin d'un bloc "Action proposée" en cherchant la
// sous-chaîne littérale "Confirmer ?", et route certaines lignes selon la
// présence de ✅/❌. Si le code affiché dans un diff edit_file contient
// lui-même ces séquences (ex: on édite ce fichier-ci), la détection côté
// client peut se terminer prématurément ou mal classer la ligne. On
// neutralise ces séquences dans les aperçus affichés (le texte reste
// lisible, juste avec un espace insécable inséré).
function neutralizeProtocolMarkers(text) {
  // \u200B (espace de largeur nulle) n'appartient PAS à la classe \s en
  // JavaScript : il survit au `.replace(/\s+/g, " ")` de cleanLine() côté
  // client, contrairement à une espace insécable (\u00A0, elle, incluse
  // dans \s et donc recollée).
  return text
    .replace(/Confirmer ?\?/g, "Confirmer\u200B ?")
    .replace(/✅/g, "✅\u200B")
    .replace(/❌/g, "❌\u200B");
}

function truncateForPreview(text, maxLength = 160) {
  const oneLine = neutralizeProtocolMarkers(String(text).replace(/\s+/g, " ").trim());

  if (oneLine.length <= maxLength) {
    return oneLine;
  }

  return oneLine.slice(0, maxLength) + "…";
}

function describeToolAction(toolName, args) {
  switch (toolName) {
    case "write_file":
      return `Écrire / remplacer entièrement le fichier : ${args.filePath}`;

    case "edit_file":
      return (
        `Modifier le fichier : ${args.filePath}\n` +
        `   - retirer : ${truncateForPreview(args.oldStr)}\n` +
        `   + ajouter : ${truncateForPreview(args.newStr)}`
      );

    case "run_command":
      return `Exécuter la commande : ${args.command}`;

    default:
      return `Exécuter l'outil : ${toolName}`;
  }
}

async function confirmAction(state, description) {
  if (state.autoAccept) {
    return true;
  }

  // La question elle-même (texte + [o/n/t]) reste sur le canal texte
  // existant pour l'instant : la migrer demanderait aussi de changer le
  // mécanisme de réponse côté UI (modale de confirmation), pas seulement
  // l'affichage. Voir la note au-dessus de emitStructured().
  console.log(`\n⚠️  Action proposée :\n   ${description}`);

  const answer = await askUser(
    "   Confirmer ? [o] oui  [n] non  [t] toujours accepter cette session : "
  );

  const normalized = answer.trim().toLowerCase();

  if (normalized === "t" || normalized === "tout" || normalized === "toujours") {
    state.autoAccept = true;
    sayStatus({ autoAccept: true });
    sayNotice("Mode auto-accept ACTIVÉ pour le reste de la session (tape /auto pour le désactiver).");
    return true;
  }

  const accepted = normalized === "o" || normalized === "oui" || normalized === "y" || normalized === "yes";

  sayNotice(accepted ? "Approuvé." : "Refusé.");

  return accepted;
}

// ==============================
// AGENT
// ==============================

// Un seul readline.Interface pour toute la session, avec une file
// d'attente pour les lignes reçues.
//
// POURQUOI UNE FILE ET PAS SIMPLEMENT rl.question() À CHAQUE APPEL :
// readline émet un événement 'line' dès qu'une ligne est disponible,
// QUE QUELQU'UN L'ATTENDE OU NON. Dans un terminal interactif classique
// ce n'est pas un problème (l'utilisateur n'a pas encore tapé la ligne
// suivante). Mais dès que l'entrée arrive d'un coup (script, entrée
// redirigée, pipe), toutes les lignes peuvent être émises avant même
// qu'on ait appelé question() pour les récupérer — les lignes émises
// "trop tôt" sont alors perdues et la question suivante reste bloquée
// indéfiniment, avec pour conséquence un arrêt silencieux du programme
// (aucune erreur : la Promise ne se résout juste jamais).
// La file d'attente ci-dessous découple réception et consommation : une
// ligne reçue avant d'être demandée est stockée ; une question posée
// avant qu'une ligne soit disponible attend son tour. Ça fonctionne à
// l'identique en terminal interactif et en entrée redirigée.

let rl = null;
const lineQueue = [];
const lineWaiters = [];

function getReadline() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.on("line", line => {
      if (lineWaiters.length > 0) {
        lineWaiters.shift()(line);
      } else {
        lineQueue.push(line);
      }
    });
  }

  return rl;
}

function askUser(question) {
  const iface = getReadline();

  iface.output.write(question);

  return new Promise(resolve => {
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift());
    } else {
      lineWaiters.push(resolve);
    }
  });
}

function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

// Variante de askUser() qui masque la saisie à l'écran (affiche des "*"
// au lieu des caractères tapés). Utilisée pour ne pas afficher une clé
// API en clair dans le terminal. Repose sur une astuce classique de
// readline (interception de l'écriture vers stdout) ; si l'environnement
// ne le permet pas (ex: entrée non-TTY), on retombe simplement sur une
// saisie visible plutôt que de faire planter l'agent.
function askUserMasked(question) {
  const iface = getReadline();
  const originalWriteToOutput = iface._writeToOutput;

  if (typeof originalWriteToOutput !== "function") {
    return askUser(question);
  }

  iface.output.write(question);

  iface._writeToOutput = function (stringToWrite) {
    if (iface.stdoutMuted) {
      iface.output.write("*");
    } else {
      originalWriteToOutput.call(iface, stringToWrite);
    }
  };
  iface.stdoutMuted = true;

  const restore = () => {
    iface._writeToOutput = originalWriteToOutput;
    iface.stdoutMuted = false;
    iface.output.write("\n");
  };

  return new Promise(resolve => {
    const onLine = line => {
      restore();
      resolve(line);
    };

    if (lineQueue.length > 0) {
      onLine(lineQueue.shift());
    } else {
      lineWaiters.push(onLine);
    }
  });
}

function showModels() {
  const providers = getAvailableProviders();

  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│ 🧠 CHOISIR UN FOURNISSEUR                    │");
  console.log("├──────────────────────────────────────────────");

  if (providers.length === 0) {
    console.log("│ ❌ Aucun fournisseur configuré.              │");
    console.log("│ Configure une clé API avec /keys.             │");
    console.log("╰──────────────────────────────────────────────╯");
    return;
  }

  providers.forEach((provider, index) => {
    console.log(
      `│ ${index + 1}. ${provider.name}`
    );
  });

  console.log("│");
  console.log("│ 0. Annuler                                    │");
  console.log("╰──────────────────────────────────────────────╯");
}

async function selectModel() {
  const providers = getAvailableProviders();

  if (providers.length === 0) {
    console.log("\n❌ Aucun fournisseur avec une clé API configurée.");
    return null;
  }

  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│  CHOISIR UN FOURNISSEUR                    │");
  console.log("├──────────────────────────────────────────────┤");

  providers.forEach((provider, index) => {
    console.log(`│ ${index + 1}. ${provider.name}`);
  });

  console.log("│ 0. Annuler                                    │");
  console.log("╰──────────────────────────────────────────────╯");

  const providerInput = await askUser("\n❯ ");
  const providerIndex = Number(providerInput);

  if (
    providerIndex === 0 ||
    !Number.isInteger(providerIndex) ||
    providerIndex < 1 ||
    providerIndex > providers.length
  ) {
    console.log("\n↩️ Sélection annulée.");
    return null;
  }

  const provider = providers[providerIndex - 1];

  console.log(`\n✅ Fournisseur : ${provider.name}`);

  // Récupération dynamique des modèles
  console.log("\n🔄 Récupération des modèles disponibles...");

  let models;

  try {
    models = await getAvailableModels(provider.id);
  } catch (error) {
    console.log("\n❌ Impossible de récupérer les modèles.");
    console.log(error.message);
    return null;
  }

  if (!models || models.length === 0) {
    console.log("\n Aucun modèle disponible pour ce fournisseur.");
    return null;
  }

  console.log(`\n✅ ${models.length} modèles récupérés.`);

  // Recherche dans les modèles
  const search = await askUser(
    "\n🔎 Rechercher un modèle (Entrée = tous) : "
  );

  const searchTerm = search.trim().toLowerCase();

  let filteredModels = models;

  if (searchTerm) {
    filteredModels = models.filter(model =>
      model.name.toLowerCase().includes(searchTerm) ||
      model.id.toLowerCase().includes(searchTerm)
    );
  }

  if (filteredModels.length === 0) {
    console.log(
      `\n Aucun modèle trouvé pour : "${search}"`
    );
    return null;
  }

  // Limiter l'affichage pour éviter 400 lignes
  const MAX_DISPLAYED_MODELS = 30;

  const displayedModels = filteredModels.slice(
    0,
    MAX_DISPLAYED_MODELS
  );

  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│ 📦 CHOISIR UN MODÈLE                         │");
  console.log("├──────────────────────────────────────────────┤");

  displayedModels.forEach((model, index) => {
    console.log(`│ ${index + 1}. ${model.name}`);
  });

  if (filteredModels.length > MAX_DISPLAYED_MODELS) {
    console.log(
      `│ ... ${filteredModels.length - MAX_DISPLAYED_MODELS} autres`
    );
  }

  console.log("│ 0. Annuler                                    │");
  console.log("╰──────────────────────────────────────────────╯");

  const modelInput = await askUser("\n❯ ");
  const modelIndex = Number(modelInput);

  if (
    modelIndex === 0 ||
    !Number.isInteger(modelIndex) ||
    modelIndex < 1 ||
    modelIndex > displayedModels.length
  ) {
    console.log("\n↩️ Sélection annulée.");
    return null;
  }

  const model = displayedModels[modelIndex - 1];

  console.log(
    `\n✅ Modèle sélectionné : ${provider.name} / ${model.name}`
  );

  console.log(`   ID : ${model.id}`);

  return {
    provider,
    model
  };
}

// ==============================
// PROVIDERS COMPATIBLES AVEC L'API "chat.completions"
// ==============================
// Chaque provider a sa propre implémentation dans runTask() :
// openai/openrouter -> API "chat.completions" (SDK OpenAI)
// anthropic          -> API "messages" (SDK Anthropic)
// google             -> API "generateContent" (SDK GoogleGenAI, function calling)
const SUPPORTED_TASK_PROVIDERS = ["openai", "openrouter", "anthropic", "google"];

function assertProviderSupported(provider) {
  if (!SUPPORTED_TASK_PROVIDERS.includes(provider)) {
    throw new Error(
      `Le fournisseur "${provider}" n'est pas encore supporté pour l'exécution des tâches. ` +
      `Seuls ${SUPPORTED_TASK_PROVIDERS.join(", ")} fonctionnent actuellement.`
    );
  }
}

// ==============================
// COMMANDES LOCALES (jamais envoyées à l'IA)
// ==============================

function showHelp() {
  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│  COMMANDES DISPONIBLES                     │");
  console.log("├──────────────────────────────────────────────┤");
  console.log("│ /model   Changer de fournisseur / modèle     │");
  console.log("│ /keys    Gérer les clés API (ajout/suppr.)   │");
  console.log("│ /auto    Basculer le mode auto-accept        │");
  console.log("│ /status  Afficher l'état actuel de la session│");
  console.log("│ /clear   Effacer l'écran du terminal         │");
  console.log("│ /help    Afficher cette aide                 │");
  console.log("│ /exit    Quitter l'agent                     │");
  console.log("╰──────────────────────────────────────────────╯");
}

function showStatus(state) {
  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│ 📊 STATUT DE LA SESSION                      │");
  console.log("──────────────────────────────────────────────┤");
  console.log(`│ 📂 Workspace     : ${state.WORKSPACE}`);
  console.log(`│ 🔌 Provider      : ${state.selectedProvider}`);
  console.log(`│ 🧠 Modèle        : ${state.modelName}`);
  console.log(`│ 🔓 Auto-accept   : ${state.autoAccept ? "activé" : "désactivé"}`);
  console.log("╰──────────────────────────────────────────────╯");
}

// ==============================
// GESTION DES CLÉS API (/keys)
// ==============================
// Permet d'ajouter, modifier et supprimer les clés API sans toucher au
// fichier .env : les clés sont stockées dans le trousseau du système
// d'exploitation via keyStore.js (module basé sur keytar).

function confirmYes(answer) {
  return /^(o|oui|y|yes)$/i.test((answer || "").trim());
}

async function showApiKeysMenu() {
  const statuses = await keyStore.listConfiguredKeys();

  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│ 🔑 CLÉS API                                   │");
  console.log("├──────────────────────────────────────────────┤");

  statuses.forEach((status, index) => {
    const label = `${index + 1}. ${status.label}`.padEnd(20);
    const state = status.configured
      ? `✅ ${status.masked} (${status.source})`
      : "❌ non configurée";

    console.log(`│ ${label}${state}`);
  });

  console.log("│");
  console.log("│ a. Ajouter / modifier une clé                 │");
  console.log("│ d. Supprimer une clé                          │");
  console.log("│ 0. Retour                                     │");
  console.log("╰──────────────────────────────────────────────╯");

  return statuses;
}

async function addOrUpdateApiKey(statuses) {
  const providerInput = await askUser(
    `\nFournisseur à configurer (${statuses.map((s, i) => `${i + 1}=${s.label}`).join(", ")}) : `
  );

  const index = Number(providerInput.trim());
  const target = statuses[index - 1];

  if (!target) {
    console.log("\n↩️ Sélection invalide, annulé.");
    return;
  }

  if (target.configured) {
    const overwrite = await askUser(
      `\n⚠️  Une clé est déjà configurée pour ${target.label} (${target.masked}, source : ${target.source}). ` +
      `La remplacer ? [o/N] : `
    );

    if (!confirmYes(overwrite)) {
      console.log("\n↩️ Annulé.");
      return;
    }
  }

  const apiKey = await askUserMasked(`\n🔐 Nouvelle clé API pour ${target.label} : `);

  if (!apiKey.trim()) {
    console.log("\n↩️ Clé vide, annulé.");
    return;
  }

  try {
    await keyStore.setKey(target.provider, apiKey);
    console.log(
      `\n✅ Clé enregistrée pour ${target.label} dans le trousseau système.\n` +
      `   Elle est disponible immédiatement (tape /model pour l'utiliser).`
    );
  } catch (error) {
    console.log(`\n❌ ${error.message}`);
  }
}

async function removeApiKey(statuses) {
  const configured = statuses.filter(s => s.configured);

  if (configured.length === 0) {
    console.log("\nAucune clé configurée à supprimer.");
    return;
  }

  console.log("\nClés configurées :");
  configured.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.label} (${s.masked}, source : ${s.source})`);
  });

  const providerInput = await askUser("\nNuméro de la clé à supprimer (Entrée = annuler) : ");
  const trimmedInput = providerInput.trim();

  if (!trimmedInput) {
    console.log("\n↩️ Annulé.");
    return;
  }

  const target = configured[Number(trimmedInput) - 1];

  if (!target) {
    console.log("\n↩️ Sélection invalide, annulé.");
    return;
  }

  const confirm = await askUser(`\n⚠️  Supprimer la clé ${target.label} ? [o/N] : `);

  if (!confirmYes(confirm)) {
    console.log("\n↩️ Annulé.");
    return;
  }

  try {
    const deletedFromKeychain = await keyStore.deleteKey(target.provider);

    if (target.source === ".env" && !deletedFromKeychain) {
      console.log(
        `\n⚠️  Cette clé provient de ton fichier .env : elle a été retirée de la session en cours, ` +
        `mais réapparaîtra au prochain démarrage.\n` +
        `   Supprime ou commente la ligne ${target.envVar} dans .env pour la retirer définitivement.`
      );
    } else {
      console.log(`\n✅ Clé supprimée pour ${target.label}.`);
    }
  } catch (error) {
    console.log(`\n❌ ${error.message}`);
  }
}

async function manageApiKeys() {
  while (true) {
    const statuses = await showApiKeysMenu();

    const choice = (await askUser("\n❯ ")).trim().toLowerCase();

    if (choice === "0" || choice === "") {
      return;
    }

    if (choice === "a") {
      await addOrUpdateApiKey(statuses);
      continue;
    }

    if (choice === "d") {
      await removeApiKey(statuses);
      continue;
    }

    console.log("\n❓ Choix invalide.");
  }
}

// ==============================
// PROMPT SYSTÈME (partagé entre tous les providers)
// ==============================

const AGENT_SYSTEM_PROMPT = `Tu es un agent de développement logiciel autonome. Ton objectif est de résoudre la demande de l'utilisateur de manière exacte, robuste et minimale.

PERIMETRE STRICT :

- Tu travailles EXCLUSIVEMENT dans le répertoire racine du workspace courant.
- N'essaie JAMAIS de naviguer, créer ou modifier des fichiers en dehors de ce périmètre ou dans un sous-projet isolé non prévu.

OUTILS DISPONIBLES ET BONNES PRATIQUES :

- list_files : Analyse la structure du projet.
- search_files : Recherche un motif (fonctions, variables, imports). À privilégier systématiquement avant de lire des fichiers un par un.
- read_file : Lis le contenu d'un fichier spécifique.
- edit_file : Effectue une modification ciblée d'un extrait exact et unique. Outil prioritaire pour les petits changements.
- write_file : Crée un nouveau fichier ou remplace l'intégralité d'un fichier existant.
- run_command : Exécute des commandes système (build, tests, linter).

RÈGLES D'EXÉCUTION ET D'EFFICIENCE :

1. Parallélisation : Regroupe TOUS les appels d'outils indépendants (ex: plusieurs lectures de fichiers ou recherches) dans un seul et même tour de réponse. Ne fais pas d'aller-retour inutile.
2. Précision du code : Vise la justesse dès la première tentative pour éviter le tâtonnement.
3. Vérification : Valide tes modifications (ex: exécution des tests, linter, ou build via run_command) de manière ciblée, sans lancer de vérifications redondantes.
4. Auto-correction : Si une commande ou un test échoue, analyse l'erreur et corrige-la immédiatement.
5. Complétion : Continue la boucle jusqu'à ce que la demande soit réellement et entièrement satisfaite. Ne déclare JAMAIS une tâche terminée si elle est partielle ou incomplète.

RÈGLES DE CONCEPTION ET DE PATTERNS :

- N'utilise JAMAIS automatiquement des patterns, architectures, structures de code ou conventions par défaut simplement parce qu'ils sont courants ou familiers.
- N'applique pas de pattern prédéfini (MVC, Singleton, Factory, Repository, Observer, etc.) sans raison technique claire.
- Analyse d'abord le contexte, le code existant et les besoins réels du projet avant de choisir une architecture ou un pattern.
- Privilégie la solution la plus simple, directe, maintenable et adaptée au projet.
- Si un pattern existant est déjà utilisé dans le projet, respecte-le lorsque cela est cohérent avec l'architecture existante.
- Ne crée pas d'abstraction, de couche, de classe, de fichier ou de système supplémentaire uniquement pour respecter une convention ou un pattern.
- Chaque pattern ou abstraction ajouté doit avoir une justification concrète liée aux besoins du projet.
- Évite le sur-engineering : ne complexifie jamais le code sans bénéfice réel.
- Avant toute modification importante, identifie les conventions et l'architecture déjà présentes dans le projet afin de conserver leur cohérence.`;

// ==============================
// GESTION VISUELLE DE L'UI (Modern CLI style)
// ==============================

function formatToolLog(toolName, args, status = "running") {
  const icons = {
    write_file: "",
    edit_file: "✏️",
    read_file: "📖",
    list_files: "📂",
    search_files: "🔎",
    run_command: "💻"
  };

  const labels = {
    write_file: "Write",
    edit_file: "Edit",
    read_file: "Read",
    list_files: "Explore",
    search_files: "Search",
    run_command: "Command"
  };

  const icon = icons[toolName] || "🛠️";
  const label = labels[toolName] || toolName;

  // Formatage propre : ✓  Label  File
  const file = args.filePath || args.command || args.directory || args.pattern;

  if (status === "success") {
    return `  ${chalk.green("✓")}  ${chalk.bold(label)}  ${file}`;
  }
  return `  ${chalk.yellow("…")}  ${chalk.bold(label)}  ${file}`;
}

// ==============================
// LIMITER LA TAILLE DE L'HISTORIQUE ENVOYÉ À L'API
// ==============================
// Sans ça, l'historique complet (y compris tous les résultats d'outils déjà
// tronqués) est renvoyé intégralement à CHAQUE tour, ce qui fait grossir
// le coût et la latence de chaque appel au fil des 20 tours max.
// On garde toujours le tout premier message (contexte initial : system/user)
// et seulement les N derniers tours pour ne pas perdre le fil trop tôt.
// 🔴 CORRECTION : cette fonction était définie DEUX FOIS dans le fichier
// d'origine (par caractères puis par tours "assistant" — la seconde
// écrasait silencieusement la première). On garde la version par tours
// "assistant", plus robuste (elle ne coupe jamais un couple
// assistant/tool_result au milieu).

function trimHistory(messages, keepLastNTurns = 8) {
  // On repère les indices où commence chaque "tour" (un message role=assistant
  // marque le début d'un nouveau tour, suivi de ses éventuels tool results).
  // "assistant" (format OpenAI/Anthropic) ET "model" (format Gemini) marquent
  // tous deux le début d'un nouveau tour.
  const turnStartIndices = messages
    .map((m, i) => (m.role === "assistant" || m.role === "model" ? i : null))
    .filter(i => i !== null);

  if (turnStartIndices.length <= keepLastNTurns) {
    return messages;
  }

  const cutoffIndex = turnStartIndices[turnStartIndices.length - keepLastNTurns];

  return [messages[0], ...messages.slice(cutoffIndex)];
}

// ==============================
// EXÉCUTION D'UNE TÂCHE — VARIANTE OPENAI / OPENROUTER
// (API "chat.completions", format OpenAI)
// ==============================

async function runTaskOpenAI(userRequest, client, modelName, state) {
  const messages = [
    {
      role: "system",
      content: AGENT_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: userRequest
    }
  ];

  const MAX_TURNS = 20;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {

    const spinner = spin("L'agent réfléchit...");

    let response;
    sayThinking(true);
    try {
      // 🔴 Historique borné pour ne pas renvoyer un contexte qui grossit sans fin
      const trimmedMessages = trimHistory(messages);

      // 🔴 Appel encapsulé avec retry/backoff sur erreurs transitoires (429, 500, 503, timeouts réseau)
      response = await callWithRetry(() =>
        client.chat.completions.create({
          model: modelName,
          messages: trimmedMessages,
          tools: tools,
          tool_choice: "auto"
        })
      );

      spinner.stop();
    } catch (error) {
      spinner.fail(chalk.red("Erreur lors de la réflexion de l'agent."));
      throw error;
    } finally {
      sayThinking(false);
    }

    const message = response.choices?.[0]?.message;

    if (!message) {
      throw new Error(
        "Réponse inattendue : " +
        JSON.stringify(response, null, 2)
      );
    }

    // Ajouter la réponse du modèle à l'historique
    messages.push(message);

    // ==========================================
    // LE MODÈLE NE DEMANDE PLUS D'OUTIL
    // ==========================================

    if (!message.tool_calls?.length) {
      sayAssistant(message.content);
      break;
    }

    // ==========================================
    // LE MODÈLE DEMANDE UN OU PLUSIEURS OUTILS
    // ==========================================

    for (const toolCall of message.tool_calls) {

      const toolName = toolCall.function.name;

      let args;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        throw new Error(
          `Arguments invalides pour ${toolName}`
        );
      }

      sayTool(toolName, args, "running");

      try {

        if (TOOLS_REQUIRING_CONFIRMATION.has(toolName)) {
          const approved = await confirmAction(state, describeToolAction(toolName, args));

          if (!approved) {
            sayTool(toolName, args, "error");
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content:
                "ERREUR : L'utilisateur a refusé cette action. " +
                "Ne retente pas exactement la même action. Explique la situation, " +
                "propose une alternative ou demande des précisions."
            });
            continue;
          }
        }

        // Spinner uniquement pour run_command, qui peut prendre du temps
        let commandSpinner = null;
        if (toolName === "run_command") {
          commandSpinner = spin(`Exécution : ${args.command}`);
        }

        let result;
        try {
          result = executeTool(toolName, args);
          commandSpinner?.succeed(chalk.green(`Terminé : ${args.command}`));
        } catch (err) {
          commandSpinner?.fail(chalk.red(`Échec : ${args.command}`));
          throw err;
        }

        sayTool(toolName, args, "success");

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: truncateToolResult(result)
        });

      } catch (toolError) {

        sayTool(toolName, args, "error");
        sayError(`Erreur outil : ${toolError.message}`);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Erreur${toolError.message}`
        });
      }
    }
  }

  // 🔴 AJOUT : si les 20 tours sont épuisés sans que le modèle n'ait rendu
  // la main (dernier `if (!message.tool_calls?.length)` jamais atteint),
  // la fonction retournait silencieusement — aucune ligne émise, donc rien
  // affiché côté web : l'utilisateur voyait juste l'agent s'arrêter sans
  // explication. "Limite de sécurité" est le texte que classifyMessage
  // (app.js) reconnaît déjà comme ligne système — la règle existait mais
  // rien ne l'émettait jamais.
  sayWarning("Votre agent a terminé son travail ou fait une pause");
}

// ==============================
// CONVERSION DES OUTILS AU FORMAT ANTHROPIC
// ==============================
// Le format OpenAI est { type: "function", function: { name, description, parameters } }
// Le format Anthropic est { name, description, input_schema }
// On garde une seule source de vérité (le tableau `tools`) et on convertit.

function toAnthropicTools(openaiTools) {
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

const anthropicTools = toAnthropicTools(tools);

// ==============================
// EXÉCUTION D'UNE TÂCHE — VARIANTE ANTHROPIC
// (API "messages", format blocs de contenu)
// ==============================

async function runTaskAnthropic(userRequest, client, modelName, state) {
  let messages = [
    {
      role: "user",
      content: userRequest
    }
  ];

  const MAX_TURNS = 20;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {

    // 🔴 Historique borné (comme pour OpenAI) : sans ça, l'historique complet
    // grossit sans fin à chaque tour, jusqu'à dépasser la fenêtre de contexte.
    const trimmedMessages = trimHistory(messages);

    sayThinking(true);
    let response;
    try {
      response = await callWithRetry(() =>
        client.messages.create({
          model: modelName,
          max_tokens: 8192, // marge suffisante pour écrire un fichier complet en un tour, évite une coupure qui forcerait un tour de plus
          system: AGENT_SYSTEM_PROMPT,
          messages: trimmedMessages,
          tools: anthropicTools
        })
      );
    } finally {
      sayThinking(false);
    }

    // Ajouter la réponse à l'historique (format Anthropic natif)
    messages.push({
      role: "assistant",
      content: response.content
    });

    const toolUseBlocks = response.content.filter(
      block => block.type === "tool_use"
    );

    // ==========================================
    // L'IA NE DEMANDE PLUS D'OUTIL
    // ==========================================

    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n");

      sayAssistant(textBlocks);
      break;
    }

    // ==========================================
    // L'IA DEMANDE UN OU PLUSIEURS OUTILS
    // ==========================================

    const toolResults = [];

    for (const block of toolUseBlocks) {

      const toolName = block.name;
      const args = block.input;

      sayTool(toolName, args, "running");

      try {

        if (TOOLS_REQUIRING_CONFIRMATION.has(toolName)) {
          const approved = await confirmAction(state, describeToolAction(toolName, args));

          if (!approved) {
            sayTool(toolName, args, "error");
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content:
                "ERREUR : L'utilisateur a refusé cette action. " +
                "Ne retente pas exactement la même action. Explique la situation, " +
                "propose une alternative ou demande des précisions.",
              is_error: true
            });
            continue;
          }
        }

        // Spinner uniquement pour run_command, qui peut prendre du temps
        let commandSpinner = null;
        if (toolName === "run_command") {
          commandSpinner = spin(`Exécution : ${args.command}`);
        }

        let result;
        try {
          result = executeTool(toolName, args);
          commandSpinner?.succeed(chalk.green(`Terminé : ${args.command}`));
        } catch (err) {
          commandSpinner?.fail(chalk.red(`Échec : ${args.command}`));
          throw err;
        }

        sayTool(toolName, args, "success");

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: truncateToolResult(result)
        });

      } catch (toolError) {

        sayTool(toolName, args, "error");
        sayError(`Erreur outil : ${toolError.message}`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `ERREUR : ${toolError.message}`,
          is_error: true
        });
      }
    }

    messages.push({
      role: "user",
      content: toolResults
    });
  }

  // 🔴 AJOUT : voir le commentaire équivalent dans runTaskOpenAI.
  sayWarning("Limite de sécurité : nombre maximum de tours (20) atteint avant la fin de la tâche. Reformule une demande plus ciblée, ou relance pour continuer.");
}

// ==============================
// CONVERSION DES OUTILS AU FORMAT GOOGLE (GEMINI)
// ==============================
// Le format OpenAI est { type: "function", function: { name, description, parameters } }
// Le format Google (functionDeclarations) attend un schéma JSON dont les
// "type" sont en MAJUSCULES (STRING, OBJECT, ARRAY, ...) au lieu de
// "string"/"object"/"array" en minuscules.

function toGoogleSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const result = {};

  if (schema.type) {
    result.type = schema.type.toUpperCase();
  }

  if (schema.description) {
    result.description = schema.description;
  }

  if (schema.properties) {
    result.properties = {};

    for (const [key, value] of Object.entries(schema.properties)) {
      result.properties[key] = toGoogleSchema(value);
    }
  }

  if (schema.items) {
    result.items = toGoogleSchema(schema.items);
  }

  if (schema.required) {
    result.required = schema.required;
  }

  return result;
}

function toGoogleTools(openaiTools) {
  return [
    {
      functionDeclarations: openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: toGoogleSchema(t.function.parameters)
      }))
    }
  ];
}

const googleTools = toGoogleTools(tools);

// ==============================
// EXÉCUTION D'UNE TÂCHE — VARIANTE GOOGLE GEMINI
// (API "generateContent", function calling)
// ==============================

async function runTaskGoogle(userRequest, client, modelName, state) {
  let contents = [
    {
      role: "user",
      parts: [{ text: userRequest }]
    }
  ];

  const MAX_TURNS = 20;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {

    // 🔴 Historique borné (comme pour OpenAI) : sans ça, l'historique complet
    // grossit sans fin à chaque tour, jusqu'à dépasser la fenêtre de contexte.
    const trimmedContents = trimHistory(contents);

    sayThinking(true);
    let response;
    try {
      response = await callWithRetry(() =>
        client.models.generateContent({
          model: modelName,
          contents: trimmedContents,
          config: {
            systemInstruction: AGENT_SYSTEM_PROMPT,
            tools: googleTools
          }
        })
      );
    } finally {
      sayThinking(false);
    }

    const candidate = response.candidates?.[0];

    if (!candidate || !candidate.content) {
      throw new Error(
        "Réponse inattendue : " +
        JSON.stringify(response, null, 2)
      );
    }

    // Ajouter la réponse du modèle à l'historique (format Google natif)
    contents.push(candidate.content);

    const functionCalls = response.functionCalls || [];

    // ==========================================
    // GEMINI NE DEMANDE PLUS D'OUTIL
    // ==========================================

    if (functionCalls.length === 0) {
      const textBlocks = (candidate.content.parts || [])
        .filter(part => part.text)
        .map(part => part.text)
        .join("\n");

      sayAssistant(textBlocks);
      break;
    }

    // ==========================================
    // GEMINI DEMANDE UN OU PLUSIEURS OUTILS
    // ==========================================

    const functionResponseParts = [];

    for (const call of functionCalls) {

      const toolName = call.name;
      const args = call.args || {};

      sayTool(toolName, args, "running");

      try {

        if (TOOLS_REQUIRING_CONFIRMATION.has(toolName)) {
          const approved = await confirmAction(state, describeToolAction(toolName, args));

          if (!approved) {
            sayTool(toolName, args, "error");
            functionResponseParts.push({
              functionResponse: {
                name: toolName,
                response: {
                  error:
                    "L'utilisateur a refusé cette action. " +
                    "Ne retente pas exactement la même action. Explique la situation, " +
                    "propose une alternative ou demande des précisions."
                }
              }
            });
            continue;
          }
        }

        // Spinner uniquement pour run_command, qui peut prendre du temps
        let commandSpinner = null;
        if (toolName === "run_command") {
          commandSpinner = spin(`Exécution : ${args.command}`);
        }

        let result;
        try {
          result = executeTool(toolName, args);
          commandSpinner?.succeed(chalk.green(`Terminé : ${args.command}`));
        } catch (err) {
          commandSpinner?.fail(chalk.red(`Échec : ${args.command}`));
          throw err;
        }

        sayTool(toolName, args, "success");

        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: { result: truncateToolResult(result) }
          }
        });

      } catch (toolError) {

        sayTool(toolName, args, "error");
        sayError(`Erreur outil : ${toolError.message}`);

        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: { error: toolError.message }
          }
        });
      }
    }

    contents.push({
      role: "user",
      parts: functionResponseParts
    });
  }

  // 🔴 AJOUT : voir le commentaire équivalent dans runTaskOpenAI.
  sayWarning("Limite de sécurité : nombre maximum de tours (20) atteint avant la fin de la tâche. Reformule une demande plus ciblée, ou relance pour continuer.");
}

// ==============================
// DISPATCHER : choisit la bonne implémentation
// selon le fournisseur actif
// ==============================

async function runTask(userRequest, provider, client, modelName, state) {
  switch (provider) {
    case "openai":
    case "openrouter":
      return await runTaskOpenAI(userRequest, client, modelName, state);

    case "anthropic":
      return await runTaskAnthropic(userRequest, client, modelName, state);

    case "google":
      return await runTaskGoogle(userRequest, client, modelName, state);

    default:
      // Ne devrait pas arriver : assertProviderSupported() bloque avant.
      throw new Error(`Fournisseur non supporté pour l'exécution : ${provider}`);
  }
}

// ==============================
// SESSION INTERACTIVE
// ==============================

async function selectWorkspace() {
  console.log("\n──────────────────────────────────────────────╮");
  console.log("│ 📂 DOSSIER DE TRAVAIL                        │");
  console.log("├──────────────────────────────────────────────┤");
  console.log(`│ Dossier actuel : ${WORKSPACE}`);
  console.log("╰──────────────────────────────────────────────╯");

  while (true) {
    const input = await askUser(
      "\n📂 Dans quel dossier veux-tu que ton agent travaille ? " +
      "(chemin absolu ou relatif, Entrée = dossier actuel) : "
    );

    const trimmed = input.trim();

    const target = trimmed === ""
      ? WORKSPACE
      : path.resolve(WORKSPACE, trimmed);

    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);

      if (!stat.isDirectory()) {
        console.log(`\n❌ "${target}" existe mais n'est pas un dossier. Réessaie.`);
        continue;
      }

      console.log(`\n✅ Dossier de travail : ${target}`);
      return target;
    }

    const create = await askUser(
      `\n❓ Le dossier "${target}" n'existe pas. Le créer ? [o] oui  [n] non : `
    );

    const normalized = create.trim().toLowerCase();

    if (normalized === "o" || normalized === "oui" || normalized === "y" || normalized === "yes") {
      try {
        fs.mkdirSync(target, { recursive: true });
        console.log(`\n✅ Dossier créé et sélectionné : ${target}`);
        return target;
      } catch (error) {
        console.log(`\n❌ Impossible de créer le dossier : ${error.message}`);
        continue;
      }
    }

    console.log("\n↩️ Réessaie avec un autre chemin.");
  }
}

async function main() {
  // ==========================================
  // 0. CHARGER LES CLÉS API STOCKÉES (trousseau système)
  // ==========================================
  // Les clés ajoutées via /keys sont stockées dans le trousseau du système
  // (voir keyStore.js). On les injecte dans process.env avant tout, sans
  // écraser une clé déjà définie dans .env.
  try {
    await keyStore.loadAllKeysIntoEnv();
  } catch (error) {
    // Ne bloque jamais le démarrage : .env reste utilisable seul.
  }

  // ==========================================
  // 1. CHOIX DU DOSSIER DE TRAVAIL
  // ==========================================
  if (WEB_MODE) {
    // En mode web, pas de prompt bloquant à chaque démarrage/redémarrage :
    // on reprend le dernier dossier connu (transmis par server.js via
    // KHORGO_WORKSPACE, détecté depuis les logs précédents de l'agent),
    // sinon le dossier courant. L'utilisateur peut toujours le changer
    // explicitement via /workspace (bouton dédié côté navigateur).
    const envWorkspace = process.env.KHORGO_WORKSPACE;

    WORKSPACE =
      envWorkspace && fs.existsSync(envWorkspace) && fs.statSync(envWorkspace).isDirectory()
        ? envWorkspace
        : process.cwd();
  } else {
    WORKSPACE = await selectWorkspace();
  }

  // ==========================================
  // 2. CHOIX DU FOURNISSEUR / MODÈLE PAR DÉFAUT
  // ==========================================
  let selectedProvider = process.env.KHORGO_PROVIDER || "openrouter";
  let selectedModelId = process.env.KHORGO_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

  let selectedModel;

  try {
    selectedModel = getModel(selectedProvider, selectedModelId);
  } catch (error) {
    selectedModel = null;
  }

  // Si le fournisseur par défaut n'est pas configuré (clé API manquante),
  // on ne bloque pas l'utilisateur : on le laisse choisir un fournisseur
  // disponible via le même flux que /model.
  if (!selectedModel) {
    if (WEB_MODE) {
      // Le provider/modèle demandé (KHORGO_PROVIDER/KHORGO_MODEL, ou le
      // défaut) n'a plus de clé configurée — typiquement parce que
      // l'utilisateur vient de la supprimer via 🔑 Clés API. Plutôt que de
      // mourir silencieusement (l'utilisateur ne le comprend que via un
      // "agent terminé" opaque), on essaie de basculer automatiquement sur
      // un autre provider qui a encore une clé, avec son premier modèle
      // disponible.
      const fallbackProviders = getAvailableProviders();

      if (fallbackProviders.length > 0) {
        try {
          const fallbackProvider = fallbackProviders[0];
          const fallbackModels = await getAvailableModels(fallbackProvider.id);

          if (fallbackModels.length > 0) {
            selectedProvider = fallbackProvider.id;
            selectedModelId = fallbackModels[0].id;
            selectedModel = getModel(selectedProvider, selectedModelId);

            console.log(
              `\n⚠️  Le fournisseur/modèle précédent n'est plus configuré. ` +
              `Bascule automatique sur : ${fallbackProvider.name} (${selectedModelId}). ` +
              `Change-le via 🧠 Modèle si besoin.`
            );
          }
        } catch (error) {
          // Le fallback a échoué (ex: liste des modèles injoignable) —
          // on retombe sur le message d'erreur ci-dessous.
          selectedModel = null;
        }
      }

      if (!selectedModel) {
        // Préfixé ❌ (et non ⚠️) pour être reconnu comme une erreur par
        // app.js (classifyMessage), et non affiché à tort comme une
        // réponse de l'IA dans la bulle de chat.
        console.log("\n❌ Aucun modèle configuré. Choisis un fournisseur via le bouton 🧠 Modèle (ou ajoute une clé via 🔑 Clés API).");
        return;
      }
    } else {

    console.log("\n⚠️  Le fournisseur par défaut (OpenRouter) n'est pas configuré.");

    let availableProviders = getAvailableProviders();

    if (availableProviders.length === 0) {
      console.log("❌ Aucun fournisseur avec une clé API n'est configuré.");

      const wantsToConfigure = await askUser(
        "\n❓ Configurer une clé API maintenant ? [O/n] : "
      );

      if (wantsToConfigure.trim() === "" || confirmYes(wantsToConfigure)) {
        await manageApiKeys();
        availableProviders = getAvailableProviders();
      }

      if (availableProviders.length === 0) {
        console.log("\n❌ Toujours aucun fournisseur configuré. Relance l'agent une fois une clé ajoutée (via /keys ou .env).");
        return;
      }
    }

    console.log("👉 Choisis un fournisseur et un modèle pour démarrer :");

    const selection = await selectModel();

    if (!selection) {
      console.log("\n❌ Aucun modèle sélectionné, arrêt de l'agent.");
      return;
    }

    try {
      assertProviderSupported(selection.provider.id);
    } catch (error) {
      console.log(`\n❌ ${error.message}`);
      return;
    }

    selectedProvider = selection.provider.id;
    selectedModelId = selection.model.id;
    selectedModel = getModel(selectedProvider, selectedModelId);
    }
  }

  let client = selectedModel.client;
  let modelName = selectedModel.model;

  // État de session partagé avec les tâches (ex: mode auto-accept).
  const state = { autoAccept: false };

  // ==========================================
  // 3. GESTION PROPRE DE CTRL+C
  // ==========================================
  // Par défaut, Ctrl+C tue le process immédiatement, ce qui peut couper
  // une écriture de fichier en plein milieu. On l'intercepte pour laisser
  // l'utilisateur quitter proprement via /exit, ou confirmer une sortie forcée.
  let sigintCount = 0;

  const iface = getReadline();

  iface.on("SIGINT", () => {
    sigintCount++;

    if (sigintCount === 1) {
      console.log("\n\n⚠️  Ctrl+C détecté. Tape /exit pour quitter proprement, ou Ctrl+C à nouveau pour forcer l'arrêt.");
      iface.prompt?.();
    } else {
      console.log("\n👋 Arrêt forcé.");
      closeReadline();
      process.exit(0);
    }
  });

  // ==========================================
  // 4. BANNIÈRE DE DÉMARRAGE
  // ==========================================
  // L'art ASCII n'a de sens qu'en terminal : en mode web, l'identité
  // "Khorgo" est déjà affichée dans l'en-tête de la page, donc on ne
  // l'envoie pas du tout (plutôt que de compter sur le client pour la
  // filtrer après coup).
  if (!WEB_MODE) {
    console.log(chalk.bold.blue(`
 ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃  khorgo - AI Development Agent           ┃
 ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`));

    console.log(`\n${chalk.dim("Workspace :")} ${WORKSPACE}`);
    console.log(`${chalk.dim("Provider  :")} ${selectedProvider}`);
    console.log(`${chalk.dim("Model     :")} ${modelName}`);
    console.log(
      state.autoAccept
        ? `${chalk.dim("Auto-accept :")} ✅ ACTIVÉ`
        : `${chalk.dim("Auto-accept :")} 🔒 DÉSACTIVÉ`
    );
    console.log(`\n${chalk.dim("Type a prompt, or /help for commands.")}`);
  }

  // Un seul événement structuré, envoyé une fois par démarrage/redémarrage :
  // remplace 4 lignes de texte que le client devait re-parser (et qui
  // s'affichaient à tort dans le fil de chat à chaque redémarrage).
  sayStatus({
    workspace: WORKSPACE,
    provider: selectedProvider,
    model: modelName,
    autoAccept: state.autoAccept
  });

  // ==========================================
  // 5. BOUCLE INTERACTIVE
  // ==========================================
  try {
    while (true) {
      // Prompt stylisé avec séparateur visuel
      const input = await askUser(
        `\n${chalk.dim("──────────────────────────────────────────────────────────────────")}\n` +
        `${chalk.blue.bold("❯")} `
      );
      const trimmed = input.trim();

      sigintCount = 0; // reset dès qu'une commande normale est tapée

      if (trimmed === "") {
        continue;
      }

      // ==========================================
      // COMMANDES LOCALES : traitées ici, jamais
      // envoyées à l'IA.
      // ==========================================

      if (trimmed.startsWith("/")) {

        if (trimmed === "/exit" || trimmed === "/quit") {
          break;
        }

        if (trimmed === "/help") {
          showHelp();
          continue;
        }

        if (trimmed === "/status") {
          showStatus({ WORKSPACE, selectedProvider, modelName, autoAccept: state.autoAccept });
          continue;
        }

        if (trimmed === "/clear") {
          console.clear();
          continue;
        }

        if (trimmed === "/auto") {
          state.autoAccept = !state.autoAccept;
          sayStatus({ autoAccept: state.autoAccept });
          sayNotice(
            state.autoAccept
              ? "✅ Mode auto-accept ACTIVÉ : les écritures/éditions/commandes ne seront plus confirmées."
              : "🔒 Mode auto-accept DÉSACTIVÉ : chaque écriture/édition/commande sera confirmée."
          );

          continue;
        }

        if (trimmed === "/workspace") {
          const newWorkspace = await selectWorkspace();
          WORKSPACE = newWorkspace;
          sayNotice("✅ Nouveau dossier de travail sélectionné.");
          sayStatus({ workspace: WORKSPACE });
          continue;
        }

        if (trimmed === "/keys") {
          await manageApiKeys();
          continue;
        }

        if (trimmed === "/model") {
          const selection = await selectModel();

          if (selection) {
            try {
              assertProviderSupported(selection.provider.id);

              selectedProvider = selection.provider.id;
              selectedModelId = selection.model.id;

              selectedModel = getModel(selectedProvider, selectedModelId);

              client = selectedModel.client;
              modelName = selectedModel.model;

              console.log(`\n✅ Fournisseur : ${selection.provider.name}`);
              console.log(`✅ Modèle : ${selection.model.name}`);
              console.log(`✅ ID : ${selection.model.id}`);
            } catch (error) {
              console.log(`\n❌ ${error.message}`);
            }
          }

          continue;
        }

        console.log(`\n❓ Commande inconnue : ${trimmed}`);
        console.log("Tape /help pour voir les commandes disponibles.");
        continue;
      }

      // ==========================================
      // DEMANDE NORMALE : envoyée à l'IA
      // ==========================================

      try {
        assertProviderSupported(selectedProvider);
        await runTask(trimmed, selectedProvider, client, modelName, state);
      } catch (error) {
        console.error("\n Erreur :");
        console.error(error.message);
      }
    }
  } finally {
    closeReadline();
  }
}

main().catch(error => {
  console.error("\n Erreur fatale :", error.message);
  process.exit(1);
});