/**
 * safePath — validation des chemins de fichiers (bac à sable du workspace).
 *
 * Extrait de agent.js pour pouvoir être testé directement (les tests
 * utilisaient auparavant une copie de la fonction, ce qui ne prouvait rien
 * sur le code réellement exécuté).
 */

const fs = require("fs");
const path = require("path");

// Protégés uniquement à la racine du workspace (code source de l'agent).
const PROTECTED_ROOT_FILES = new Set([
  "agent.js",
  "modelManager.js",
  "models.js",
  "keyStore.js",
  "safePath.js",
  "package.json",
  "package-lock.json"
]);

// Protégés à n'importe quelle profondeur : secrets et exécution de code
// indirecte (ex: .git/hooks/* s'exécute lors d'un `git commit`, ce qui
// contournerait le filtre de commandes).
const PROTECTED_ANYWHERE = new Set([".git", "node_modules"]);

function isProtectedAnywhere(segment) {
  const s = segment.toLowerCase();
  return PROTECTED_ANYWHERE.has(s) || s === ".env" || s.startsWith(".env.");
}

function normalizeForComparison(p) {
  if (process.platform === "win32") {
    return p.toLowerCase().replace(/\//g, "\\");
  }
  return p;
}

/**
 * @param {() => string} getWorkspace  retourne le workspace (déjà résolu)
 * @returns {(filePath: string) => string}
 */
function createSafePath(getWorkspace) {
  // Racine résolue, mise en cache (realpathSync est lent, surtout sous Windows).
  let cachedFor = null;
  let cachedRoot = null;
  function getRoot() {
    const ws = getWorkspace();
    if (cachedFor !== ws) {
      cachedRoot = fs.realpathSync(ws);
      cachedFor = ws;
    }
    return cachedRoot;
  }

  // La normalisation (minuscules sous Windows) ne sert qu'à COMPARER :
  // les chemins renvoyés gardent leur casse réelle.
  function isInside(rootCmp, candidate) {
    const c = normalizeForComparison(candidate);
    return c === rootCmp || c.startsWith(rootCmp + path.sep);
  }

  return function safePath(filePath) {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Chemin de fichier invalide");
    }
    if (filePath.indexOf("\0") !== -1) {
      throw new Error("Chemin invalide : caractère nul détecté");
    }

    const root = getRoot();
    const rootCmp = normalizeForComparison(root);
    const absolutePath = path.resolve(root, filePath);

    // Remonte jusqu'au premier ancêtre existant.
    // lstat (et non existsSync) : un symlink dangling (cible inexistante)
    // doit compter comme existant, sinon on l'ignorait et l'écriture
    // suivait ensuite le lien vers l'extérieur du workspace.
    let existingAncestor = absolutePath;
    let remainder = "";
    const MAX_DEPTH = 1024;
    let depth = 0;

    const exists = p => {
      try { fs.lstatSync(p); return true; } catch { return false; }
    };

    while (!exists(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor || depth++ > MAX_DEPTH) break;
      remainder = path.join(path.basename(existingAncestor), remainder);
      existingAncestor = parent;
    }

    let resolvedAncestor;
    try {
      // Échoue sur un symlink dangling -> accès refusé (comportement voulu).
      resolvedAncestor = fs.realpathSync(existingAncestor);
    } catch (error) {
      throw new Error(
        `Impossible de résoudre le chemin : ${existingAncestor} (${error.message})`
      );
    }

    const fullPath = remainder ? path.join(resolvedAncestor, remainder) : resolvedAncestor;

    if (!isInside(rootCmp, fullPath)) {
      throw new Error(`Accès refusé hors de l'espace de travail : ${filePath}`);
    }

    const relative = path.relative(root, fullPath);
    const segments = relative.split(path.sep).filter(Boolean);

    if (segments.length > 0) {
      const top = segments[0].toLowerCase();
      if (PROTECTED_ROOT_FILES.has(top) || isProtectedAnywhere(segments[0])) {
        throw new Error(`Accès refusé : '${top}' fait partie de mon code source interne.`);
      }
      const hit = segments.find(isProtectedAnywhere);
      if (hit) {
        throw new Error(`Accès refusé : '${hit.toLowerCase()}' fait partie de mon code source interne.`);
      }
    }

    return fullPath;
  };
}

module.exports = { createSafePath, PROTECTED_ROOT_FILES, PROTECTED_ANYWHERE };