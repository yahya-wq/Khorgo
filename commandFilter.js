/**
 * commandFilter — validation des commandes lancées par run_command.
 *
 * Remplace l'ancien filtre (découpage par regex) qui :
 *  - refusait des commandes légitimes (`npm test 2>&1`, `git commit -m "a & b"`,
 *    `npm run format`...) parce qu'il coupait sur & ; | même entre guillemets ;
 *  - laissait passer `node --eval="..."` et les redirections `> ../../fichier`.
 *
 * Principe : on analyse la commande comme un shell (guillemets, échappements,
 * opérateurs, redirections), puis chaque segment (commande + arguments +
 * redirections) est validé. Ce n'est PAS une vraie isolation : `node script.js`
 * exécute n'importe quel code. C'est un garde-fou contre les erreurs du modèle.
 */

const path = require("path");

const ALLOWED_BASE_COMMANDS = [
  "node", "npm", "npx", "yarn", "pnpm", "tsc",
  "python", "python3", "py", "pip", "pip3",
  "git",
  "dir", "ls", "cd", "mkdir", "touch", "echo"
];

// Options de node qui prennent une valeur (pour savoir où commence le script).
const NODE_VALUE_FLAGS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--env-file", "-C", "--conditions", "--input-type"
]);

// Sous-commandes git qui exécutent des programmes arbitraires.
const GIT_BLOCKED_SUBCOMMANDS = new Set([
  "difftool", "mergetool", "filter-branch", "daemon", "instaweb", "gui", "web--browse"
]);

// Clés `git config` qui permettent d'exécuter des commandes.
const GIT_DANGEROUS_CONFIG = [
  "alias.", "core.sshcommand", "core.pager", "core.editor", "core.fsmonitor",
  "core.hookspath", "core.askpass", "core.gitproxy", "credential.", "gpg.",
  "diff.", "merge.", "filter.", "sequence.editor", "difftool.", "mergetool.",
  "pager.", "include.", "includeif.", "url.", "protocol."
];

function refuse(message) {
  throw new Error(`Commande refusée : ${message}`);
}

const isNullDevice = v => /^(\/dev\/null|nul)$/i.test(v);

/**
 * Analyse une commande façon shell. Retourne une liste de segments
 * { words: [cmd, ...args], redirects: [{ op, target }] }.
 * Lève une erreur sur tout ce qu'on refuse d'interpréter (substitution,
 * here-document, guillemet non fermé...).
 */
function parseCommand(command, platform = process.platform) {
  const win = platform === "win32";
  const s = String(command);
  const segments = [];
  let seg = { words: [], redirects: [] };
  let word = null;            // mot en cours (null = aucun)
  let pendingRedirect = null; // opérateur de redirection en attente de cible

  function pushWord() {
    if (word === null) return;
    if (pendingRedirect) {
      seg.redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      seg.words.push(word);
    }
    word = null;
  }

  function endSegment() {
    pushWord();
    if (pendingRedirect) refuse("redirection sans cible.");
    if (seg.words.length) segments.push(seg);
    else if (seg.redirects.length) refuse("redirection sans commande.");
    seg = { words: [], redirects: [] };
  }

  function beginRedirect(op) {
    pushWord();
    if (pendingRedirect) refuse("redirection invalide.");
    pendingRedirect = op;
  }

  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === " " || c === "\t" || c === "\r") { pushWord(); i++; continue; }
    if (c === "\n") { endSegment(); i++; continue; }

    // Guillemets simples : littéraux (POSIX seulement ; cmd.exe ne les connaît pas)
    if (c === "'" && !win) {
      const end = s.indexOf("'", i + 1);
      if (end === -1) refuse("guillemet simple non fermé.");
      word = (word ?? "") + s.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    // Guillemets doubles
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      for (;; j++) {
        if (j >= s.length) refuse("guillemet double non fermé.");
        const d = s[j];
        if (d === '"') break;
        if (!win && d === "\\" && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) {
          buf += s[j + 1];
          j++;
          continue;
        }
        if (!win && (d === "$" || d === "`")) {
          refuse("la substitution de commande ou de variable ($, `) n'est pas autorisée.");
        }
        buf += d;
      }
      word = (word ?? "") + buf;
      i = j + 1;
      continue;
    }

    // Antislash (POSIX) : le caractère suivant est littéral
    if (c === "\\" && !win) {
      if (i + 1 >= s.length) refuse("antislash en fin de commande.");
      if (s[i + 1] === "\n") { i += 2; continue; }
      word = (word ?? "") + s[i + 1];
      i += 2;
      continue;
    }

    // cmd.exe : ^ échappe un caractère et permettrait de masquer un argument
    if (c === "^" && win) refuse("le caractère ^ n'est pas autorisé.");

    if (!win && (c === "$" || c === "`")) {
      refuse("la substitution de commande ou de variable ($, `) n'est pas autorisée.");
    }
    if (!win && "{}()".includes(c)) {
      refuse(`le caractère « ${c} » (groupement / expansion du shell) n'est pas autorisé hors guillemets.`);
    }

    // Opérateurs de séparation
    if (c === ";") { endSegment(); i++; continue; }
    if (c === "|") {
      endSegment();
      i += (s[i + 1] === "|" || s[i + 1] === "&") ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (s[i + 1] === ">") {            // &> et &>>
        const op = s[i + 2] === ">" ? "&>>" : "&>";
        beginRedirect(op);
        i += op.length;
        continue;
      }
      endSegment();
      i += s[i + 1] === "&" ? 2 : 1;
      continue;
    }

    // Redirections
    if (c === ">" || c === "<") {
      if (word !== null && /^\d+$/.test(word)) word = null; // préfixe de descripteur (2>)
      else pushWord();
      if (c === "<" && s[i + 1] === "<") refuse("here-document (<<) non supporté.");
      let op = c;
      if (c === ">" && s[i + 1] === ">") op = ">>";
      else if (c === ">" && s[i + 1] === "|") op = ">|";
      i += op.length;
      if (s[i] === "&") {                // 2>&1, >&2 : duplication de descripteur
        const m = /^&(\d+|-)/.exec(s.slice(i));
        if (!m) refuse("redirection « >& » non reconnue.");
        i += m[0].length;
        continue;
      }
      beginRedirect(op);
      continue;
    }

    word = (word ?? "") + c;
    i++;
  }

  endSegment();
  return segments;
}

/**
 * @param {object}   opts
 * @param {(p: string) => string} opts.safePath  valide un chemin dans le workspace
 * @param {string}   [opts.platform]             pour les tests
 * @param {string[]} [opts.allowedCommands]
 */
function createCommandFilter({ safePath, platform = process.platform, allowedCommands = ALLOWED_BASE_COMMANDS }) {
  if (typeof safePath !== "function") {
    throw new Error("createCommandFilter : safePath est requis.");
  }
  const win = platform === "win32";

  // Option de type /s, /b, /d (cmd.exe) : pas un chemin.
  const isWinSwitch = a => win && /^\/[A-Za-z?]+$/.test(a);
  const isFlag = a => a.startsWith("-") || isWinSwitch(a);

  function checkPath(value, label) {
    try {
      safePath(value);
    } catch (error) {
      refuse(`${label} « ${value} » refusé (${error.message}).`);
    }
  }

  // Un argument qui sort du workspace (.., absolu, ~) doit passer par safePath.
  function escapingValue(token) {
    let v = token;
    if (v.startsWith("-")) {
      const eq = v.indexOf("=");
      v = eq === -1 ? "" : v.slice(eq + 1);
    }
    if (!v) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null; // URL
    if (isWinSwitch(v) || isNullDevice(v)) return null;
    const escapes =
      /(^|[\\/])\.\.([\\/]|$)/.test(v) ||
      v.startsWith("~") ||
      path.isAbsolute(v) ||
      /^[A-Za-z]:[\\/]/.test(v) ||
      v.startsWith("\\\\");
    return escapes ? v : null;
  }

  function assertNoInlineNode(args) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--" || !a.startsWith("-")) break; // premier non-flag = le script
      if (/^--(eval|print|interactive)(=|$)/.test(a) || /^-[A-Za-z]*[epi][A-Za-z]*$/.test(a)) {
        refuse(
          `l'exécution de code inline (« node ${a} ») contourne le bac à sable. ` +
          `Écris le code dans un fichier avec write_file puis lance « node fichier.js ».`
        );
      }
      if (/^--(import|require|loader|experimental-loader)=data:/i.test(a)) {
        refuse("le chargement de code inline (data:) est bloqué.");
      }
      if (NODE_VALUE_FLAGS.has(a)) {
        if (/^data:/i.test(args[i + 1] || "")) refuse("le chargement de code inline (data:) est bloqué.");
        i++;
      }
    }
  }

  function assertNoInlinePython(args) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith("-")) break;                 // le script
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        refuse(
          `l'exécution de code inline (« python ${a} ») contourne le bac à sable. ` +
          `Écris le code dans un fichier avec write_file puis lance « python fichier.py ».`
        );
      }
      if (a === "-m" || /^-[A-Za-z]*m$/.test(a)) break; // le reste = arguments du module
      if (a === "-W" || a === "-X") i++;
    }
  }

  function assertGit(args) {
    let i = 0;
    for (; i < args.length && args[i].startsWith("-"); i++) {
      const opt = args[i];
      if (opt === "-c" || /^-c./.test(opt) || /^--(config-env|exec-path)/.test(opt)) {
        refuse("« git -c » / --exec-path peuvent exécuter des programmes arbitraires.");
      }
      if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(opt)) i++;
    }
    const sub = (args[i] || "").toLowerCase();
    const rest = args.slice(i + 1);

    if (GIT_BLOCKED_SUBCOMMANDS.has(sub)) refuse(`« git ${sub} » exécute des programmes externes.`);
    if (rest.some(a => /^--(upload-pack|receive-pack|ext-cmd)(=|$)/.test(a))) {
      refuse("option git exécutant un programme externe.");
    }
    if (sub === "rebase" && rest.some(a => a === "-x" || /^--exec(=|$)/.test(a))) {
      refuse("« git rebase --exec » exécute des commandes arbitraires.");
    }
    if (sub === "bisect" && rest[0] === "run") refuse("« git bisect run » exécute des commandes arbitraires.");
    if (sub === "submodule" && rest.includes("foreach")) refuse("« git submodule foreach » exécute des commandes arbitraires.");
    if (sub === "config") {
      if (rest.some(a => a === "-e" || a === "--edit")) refuse("« git config --edit » n'est pas autorisé.");
      const key = rest.find(a => !a.startsWith("-") && GIT_DANGEROUS_CONFIG.some(k => a.toLowerCase().startsWith(k)));
      if (key) refuse(`modifier « ${key} » permettrait d'exécuter des commandes.`);
    }
  }

  function assertPackageRunner(base, args) {
    if (args.some(a => /script-shell|onload-script/i.test(a))) {
      refuse("option de configuration exécutant un shell personnalisé.");
    }
    const isExec = base === "npx" || args.some(a => a === "exec" || a === "x");
    if (isExec && args.some(a => /^(-c|--call)(=|$)/.test(a))) {
      refuse("« -c / --call » exécute une commande shell arbitraire.");
    }
  }

  function assertSegment(seg) {
    const [rawCmd, ...args] = seg.words;
    const base = rawCmd.toLowerCase();

    if (!allowedCommands.includes(base)) {
      refuse(`« ${rawCmd} » n'est pas une commande autorisée. Commandes permises : ${allowedCommands.join(", ")}.`);
    }

    if (base === "node") assertNoInlineNode(args);
    if (base === "python" || base === "python3" || base === "py") assertNoInlinePython(args);
    if (base === "git") assertGit(args);
    if (["npm", "npx", "yarn", "pnpm"].includes(base)) assertPackageRunner(base, args);

    if (base === "cd" || base === "mkdir" || base === "touch") {
      // Ces commandes ne prennent que des chemins : tous doivent rester dans le workspace.
      for (const a of args) if (!isFlag(a)) checkPath(a, "chemin");
    } else {
      for (const a of args) {
        const v = escapingValue(a);
        if (v !== null) checkPath(v, "argument");
      }
    }

    for (const r of seg.redirects) {
      if (isNullDevice(r.target)) continue;
      checkPath(r.target, `redirection (${r.op}) vers`);
    }
  }

  function assertCommandAllowed(command) {
    if (typeof command !== "string" || !command.trim()) refuse("commande vide.");
    const segments = parseCommand(command, platform);
    if (segments.length === 0) refuse("commande vide.");
    for (const seg of segments) assertSegment(seg);
  }

  return { assertCommandAllowed };
}

module.exports = { createCommandFilter, parseCommand, ALLOWED_BASE_COMMANDS };