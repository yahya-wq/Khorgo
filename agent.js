#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");


const chalk = require("chalk");
const ora = require("ora");

const OpenAI = require("openai");
const { getModel, getAvailableProviders, getAvailableModels, hasApiKey } = require("./modelManager");
const keyStore = require("./keyStore");

let WORKSPACE = process.cwd();




const WEB_MODE = process.env.KHORGO_WEB === "1";







function spin(text) {
  if (WEB_MODE) return { stop() {}, succeed() {}, fail() {} };
  return ora(chalk.cyan(text)).start();
}




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


























function emitStructured(type, payload = {}) {
  if (WEB_MODE && typeof process.send === "function") {
    try {
      process.send({ type, ...payload });
    } catch {


    }
  }
}






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





function sayThinking(active) {
  if (WEB_MODE) emitStructured("thinking", { active });
}


function sayNotice(text) {
  if (WEB_MODE) emitStructured("notice", { text });
  else console.log(text);
}




function sayStatus(status) {
  if (WEB_MODE) emitStructured("status", status || {});
}





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











let RESOLVED_WORKSPACE = null;

function getResolvedWorkspace() {
  if (RESOLVED_WORKSPACE) return RESOLVED_WORKSPACE;

  try {

    RESOLVED_WORKSPACE = fs.realpathSync(WORKSPACE);
  } catch (error) {


    RESOLVED_WORKSPACE = path.resolve(WORKSPACE);
  }



  if (process.platform === "win32") {
    RESOLVED_WORKSPACE = RESOLVED_WORKSPACE.toLowerCase().replace(/\//g, "\\");
  }

  return RESOLVED_WORKSPACE;
}


function normalizeForComparison(p) {
  if (process.platform === "win32") {
    return p.toLowerCase().replace(/\//g, "\\");
  }
  return p;
}

function isInsideWorkspace(candidatePath) {
  const root = getResolvedWorkspace();
  const normalized = normalizeForComparison(candidatePath);


  return normalized === root || normalized.startsWith(root + path.sep);
}

function safePath(filePath) {

  if (!filePath || typeof filePath !== "string") {
    throw new Error("Chin de fichier invalide");
  }


  if (filePath.indexOf("\0") !== -1) {
    throw new Error("Chemin invalide : caractère nul détecté");
  }

  const root = getResolvedWorkspace();
  const absolutePath = path.resolve(root, filePath);




  let existingAncestor = absolutePath;
  let remainder = "";


  const MAX_DEPTH = 1024;
  let depth = 0;

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);

    if (parent === existingAncestor || depth++ > MAX_DEPTH) {

      break;
    }

    remainder = path.join(path.basename(existingAncestor), remainder);
    existingAncestor = parent;
  }




  let resolvedAncestor;
  try {
    resolvedAncestor = fs.realpathSync(existingAncestor);
  } catch (error) {

    throw new Error(
      `Impossible de résoudre le chemin : ${existingAncestor} (${error.message})`
    );
  }


  const fullPath = remainder
    ? path.join(resolvedAncestor, remainder)
    : resolvedAncestor;




  if (!isInsideWorkspace(fullPath)) {
    throw new Error(
      `Accès refusé hors de l'espace de travail : ${filePath}`
    );
  }







  try {
    const lstat = fs.lstatSync(fullPath);

    if (lstat.isSymbolicLink()) {

      const linkTarget = fs.realpathSync(fullPath);

      if (!isInsideWorkspace(linkTarget)) {
        throw new Error(
          `Accès refusé : '${filePath}' est un symlink pointant hors de l'espace de travail`
        );
      }
    }
  } catch (error) {

    if (error.message.startsWith("Accès refusé")) {
      throw error;
    }


  }




  const relativePath = path.relative(root, normalizeForComparison(fullPath));
  const topLevelEntity = relativePath.split(path.sep)[0].toLowerCase();

  const protectedLower = new Set([...PROTECTED_FILES].map(f => f.toLowerCase()));

  if (protectedLower.has(topLevelEntity)) {
    throw new Error(
      `Accès refusé : '${topLevelEntity}' fait partie de mon code source interne.`
    );
  }

  return fullPath;
}


function isWithinWorkspace(fullPath) {
  let resolved = fullPath;
  try {
    resolved = fs.realpathSync(fullPath);
  } catch {
    return true; // n'existe pas (ou lien cassé) : rien à résoudre, pas bloquant ici
  }
  return resolved === WORKSPACE || resolved.startsWith(WORKSPACE + path.sep);
}





function readFile(filePath, startLine, endLine) {
  const fullPath = safePath(filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Fichier introuvable : ${filePath}`);
  }

  const content = fs.readFileSync(fullPath, "utf8");


  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n');
    const start = startLine ? Math.max(1, startLine) - 1 : 0;
    const end = endLine ? Math.min(lines.length, endLine) : lines.length;
    return lines.slice(start, end).join('\n');
  }

  return content;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1 Mo (ajuste selon tes besoins)

function writeFile(filePath, content) {
  const fullPath = safePath(filePath);


  const contentSize = Buffer.byteLength(content, "utf8");
  
  if (contentSize > MAX_FILE_SIZE) {
    throw new Error(
      `Fichier trop volumineux : ${(contentSize / 1024 / 1024).toFixed(2)} Mo ` +
      `(limite : ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} Mo). ` +
      `Divise le contenu en plusieurs fichiers ou réduis la taille.`
    );
  }

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

        if (
          entry.name === "node_modules" ||
          entry.name === ".agent"
        ) {
          continue;
        }


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


        if (!isWithinWorkspace(entryPath)) {
          continue;
        }

        explore(entryPath, entryRelativePath);
        continue;
      }




      let content;
      try {
        content = fs.readFileSync(entryPath, "utf8");
      } catch {
        continue;
      }




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


const COMMAND_SUBSTITUTION = /`|\$\(/;










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




  const segments = trimmed.split(/&&|\|\||;|\||&/);

  for (const segment of segments) {
    assertSegmentAllowed(segment);
  }
}











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


    const stdout = error.stdout ? error.stdout.toString() : "";
    const stderr = error.stderr ? error.stderr.toString() : "";

    throw new Error(
      `La commande a échoué (code ${error.status ?? "inconnu"}).\n` +
      (stdout ? `--- stdout ---\n${stdout}\n` : "") +
      (stderr ? `--- stderr ---\n${stderr}` : error.message)
    );
  }
}





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









const TOOLS_REQUIRING_CONFIRMATION = new Set([
  "write_file",
  "edit_file",
  "run_command"
]);









function neutralizeProtocolMarkers(text) {




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








const SUPPORTED_TASK_PROVIDERS = ["openai", "openrouter", "anthropic", "google"];

function assertProviderSupported(provider) {
  if (!SUPPORTED_TASK_PROVIDERS.includes(provider)) {
    throw new Error(
      `Le fournisseur "${provider}" n'est pas encore supporté pour l'exécution des tâches. ` +
      `Seuls ${SUPPORTED_TASK_PROVIDERS.join(", ")} fonctionnent actuellement.`
    );
  }
}





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


  const file = args.filePath || args.command || args.directory || args.pattern;

  if (status === "success") {
    return `  ${chalk.green("✓")}  ${chalk.bold(label)}  ${file}`;
  }
  return `  ${chalk.yellow("…")}  ${chalk.bold(label)}  ${file}`;
}















function trimHistory(messages, keepLastNTurns = 8) {




  const turnStartIndices = messages
    .map((m, i) => (m.role === "assistant" || m.role === "model" ? i : null))
    .filter(i => i !== null);

  if (turnStartIndices.length <= keepLastNTurns) {
    return messages;
  }

  const cutoffIndex = turnStartIndices[turnStartIndices.length - keepLastNTurns];

  return [messages[0], ...messages.slice(cutoffIndex)];
}






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

      const trimmedMessages = trimHistory(messages);


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


    messages.push(message);





    if (!message.tool_calls?.length) {
      sayAssistant(message.content);
      break;
    }





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








  sayWarning("Votre agent a terminé son travail ou fait une pause");
}








function toAnthropicTools(openaiTools) {
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

const anthropicTools = toAnthropicTools(tools);






async function runTaskAnthropic(userRequest, client, modelName, state) {
  let messages = [
    {
      role: "user",
      content: userRequest
    }
  ];

  const MAX_TURNS = 20;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {



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


    messages.push({
      role: "assistant",
      content: response.content
    });

    const toolUseBlocks = response.content.filter(
      block => block.type === "tool_use"
    );





    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n");

      sayAssistant(textBlocks);
      break;
    }





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


  sayWarning("Limite de sécurité : nombre maximum de tours (20) atteint avant la fin de la tâche. Reformule une demande plus ciblée, ou relance pour continuer.");
}









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






async function runTaskGoogle(userRequest, client, modelName, state) {
  let contents = [
    {
      role: "user",
      parts: [{ text: userRequest }]
    }
  ];

  const MAX_TURNS = 20;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {



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


    contents.push(candidate.content);

    const functionCalls = response.functionCalls || [];





    if (functionCalls.length === 0) {
      const textBlocks = (candidate.content.parts || [])
        .filter(part => part.text)
        .map(part => part.text)
        .join("\n");

      sayAssistant(textBlocks);
      break;
    }





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


  sayWarning("Limite de sécurité : nombre maximum de tours (20) atteint avant la fin de la tâche. Reformule une demande plus ciblée, ou relance pour continuer.");
}






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

      throw new Error(`Fournisseur non supporté pour l'exécution : ${provider}`);
  }
}





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






  try {
    await keyStore.loadAllKeysIntoEnv();
  } catch (error) {

  }




  if (WEB_MODE) {





    const envWorkspace = process.env.KHORGO_WORKSPACE;

    WORKSPACE =
      envWorkspace && fs.existsSync(envWorkspace) && fs.statSync(envWorkspace).isDirectory()
        ? envWorkspace
        : process.cwd();
  } else {
    WORKSPACE = await selectWorkspace();
  }




  let selectedProvider = process.env.KHORGO_PROVIDER || "openrouter";
  let selectedModelId = process.env.KHORGO_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

  let selectedModel;

  try {
    selectedModel = getModel(selectedProvider, selectedModelId);
  } catch (error) {
    selectedModel = null;
  }




  if (!selectedModel) {
    if (WEB_MODE) {







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


          selectedModel = null;
        }
      }

      if (!selectedModel) {



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


  const state = { autoAccept: false };







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




  sayStatus({
    workspace: WORKSPACE,
    provider: selectedProvider,
    model: modelName,
    autoAccept: state.autoAccept
  });




  try {
    while (true) {

      const input = await askUser(
        `\n${chalk.dim("──────────────────────────────────────────────────────────────────")}\n` +
        `${chalk.blue.bold("❯")} `
      );
      const trimmed = input.trim();

      sigintCount = 0; // reset dès qu'une commande normale est tapée

      if (trimmed === "") {
        continue;
      }






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