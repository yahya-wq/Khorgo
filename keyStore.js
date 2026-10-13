"use strict";

// ==============================================================
// keyStore.js
// ==============================================================
// Gère le stockage des clés API dans le trousseau du système
// d'exploitation (Keychain sur macOS, Credential Manager sur
// Windows, libsecret sur Linux) via le module "keytar", plutôt
// que dans le fichier .env.
//
// API attendue par agent.js :
//   - loadAllKeysIntoEnv()        -> injecte les clés stockées dans process.env
//                                     (sans écraser une clé déjà définie via .env)
//   - listConfiguredKeys()        -> renvoie le statut de chaque fournisseur
//   - setKey(provider, apiKey)    -> enregistre/écrase une clé dans le trousseau
//   - deleteKey(provider)         -> supprime une clé du trousseau
// ==============================================================

const keytar = require("keytar");
const fs = require("fs");
const path = require("path");

const SERVICE_NAME = "khorgo-agent";

// Chemin du .env : le même que celui que dotenv.config() charge par défaut
// (require("dotenv").config() dans modelManager.js, sans path explicite).
const ENV_PATH = path.join(process.cwd(), ".env");

// ==============================
// FOURNISSEURS SUPPORTÉS
// ==============================
// Associe chaque fournisseur (utilisé par modelManager.js) à son label
// affiché dans le menu /keys et à la variable d'environnement que les
// SDK (OpenAI / Anthropic / Google) vont lire.
const PROVIDERS = [
  { provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  { provider: "google", label: "Google Gemini", envVar: "GOOGLE_API_KEY" },
];

function getProviderConfig(providerId) {
  const config = PROVIDERS.find(p => p.provider === providerId);

  if (!config) {
    throw new Error(`Fournisseur inconnu : ${providerId}`);
  }

  return config;
}

// Mémorise, au chargement du module (donc avant toute injection depuis le
// trousseau), quels fournisseurs avaient déjà une clé via .env / l'environnement.
// Sert à distinguer la source (".env" vs "trousseau système") dans listConfiguredKeys().
const envKeysAtStartup = new Set(
  PROVIDERS.filter(({ envVar }) => !!process.env[envVar]).map(p => p.provider)
);

function maskKey(key) {
  if (!key) {
    return "";
  }

  const visible = key.slice(-4);
  const hiddenLength = Math.max(key.length - 4, 4);

  return `${"•".repeat(hiddenLength)}${visible}`;
}

// ==============================
// disableKeyInEnvFile
// ==============================
// Commente (plutôt que supprime, pour ne pas perdre la valeur) la ligne
// "ENV_VAR=..." correspondante dans le fichier .env, si elle existe.
// C'est ce qui manquait : sans ça, une clé venant de .env "revenait"
// automatiquement à chaque redémarrage puisque dotenv la recharge.
// Renvoie true si une ligne a effectivement été désactivée.
function disableKeyInEnvFile(envVar) {
  if (!fs.existsSync(ENV_PATH)) {
    return false;
  }

  let content;

  try {
    content = fs.readFileSync(ENV_PATH, "utf8");
  } catch (error) {
    return false;
  }

  const lines = content.split(/\r?\n/);
  let modified = false;

  const newLines = lines.map(line => {
    // Ne touche qu'aux lignes NON déjà commentées qui assignent cette variable.
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/);

    if (match && match[2] === envVar) {
      modified = true;
      return `# ${line}  # retirée via /keys (khorgo) le ${new Date().toISOString()}`;
    }

    return line;
  });

  if (!modified) {
    return false;
  }

  try {
    fs.writeFileSync(ENV_PATH, newLines.join("\n"), "utf8");
  } catch (error) {
    // Fichier .env non accessible en écriture (permissions, lecture seule...).
    return false;
  }

  return true;
}

// ==============================
// loadAllKeysIntoEnv
// ==============================
// Appelée une fois au démarrage de l'agent. Injecte dans process.env
// toutes les clés stockées dans le trousseau système, SANS écraser une
// clé déjà présente (typiquement définie dans .env, qui garde priorité).
async function loadAllKeysIntoEnv() {
  for (const { provider, envVar } of PROVIDERS) {
    if (process.env[envVar]) {
      continue; // .env (ou l'environnement) a déjà la priorité
    }

    try {
      const storedKey = await keytar.getPassword(SERVICE_NAME, provider);

      if (storedKey) {
        process.env[envVar] = storedKey;
      }
    } catch (error) {
      // Le trousseau système peut être indisponible (ex : pas de libsecret
      // installé sur certaines distributions Linux minimales). On ignore
      // silencieusement : .env reste utilisable seul dans ce cas.
    }
  }
}

// ==============================
// listConfiguredKeys
// ==============================
// Renvoie, pour chaque fournisseur supporté, son statut de configuration :
// { provider, label, envVar, configured, masked, source }
async function listConfiguredKeys() {
  const statuses = [];

  for (const { provider, label, envVar } of PROVIDERS) {
    let configured = false;
    let masked = null;
    let source = null;

    if (envKeysAtStartup.has(provider)) {
      // Une clé était déjà présente via .env / l'environnement au démarrage.
      configured = true;
      masked = maskKey(process.env[envVar]);
      source = ".env";
    } else {
      try {
        const storedKey = await keytar.getPassword(SERVICE_NAME, provider);

        if (storedKey) {
          configured = true;
          masked = maskKey(storedKey);
          source = "trousseau système";
        }
      } catch (error) {
        // Trousseau indisponible : la clé est simplement considérée comme
        // non configurée plutôt que de faire planter le menu /keys.
      }
    }

    statuses.push({ provider, label, envVar, configured, masked, source });
  }

  return statuses;
}

// ==============================
// setKey
// ==============================
// Enregistre (ou écrase) la clé API d'un fournisseur dans le trousseau
// système, et la rend immédiatement disponible dans la session en cours.
async function setKey(providerId, apiKey) {
  const { envVar } = getProviderConfig(providerId);

  if (!apiKey || !apiKey.trim()) {
    throw new Error("La clé API ne peut pas être vide.");
  }

  const trimmedKey = apiKey.trim();

  // On ne désactive la ligne .env (si elle existe) qu'une fois la nouvelle
  // clé validée — jamais avant, pour ne pas casser une clé .env valide sur
  // un appel invalide (clé vide, erreur d'appel, etc.).
  disableKeyInEnvFile(envVar);

  try {
    await keytar.setPassword(SERVICE_NAME, providerId, trimmedKey);
  } catch (error) {
    throw new Error(
      `Impossible d'enregistrer la clé dans le trousseau système : ${error.message}`
    );
  }

  process.env[envVar] = trimmedKey;
}

// ==============================
// deleteKey
// ==============================
// Supprime la clé d'un fournisseur du trousseau système et de la session
// en cours. Renvoie true si une clé a bien été supprimée DU TROUSSEAU
// (utile pour distinguer le cas d'une clé venant uniquement de .env, qui
// réapparaîtra au prochain démarrage tant que .env n'est pas modifié).
async function deleteKey(providerId) {
  const { envVar } = getProviderConfig(providerId);
  disableKeyInEnvFile(envVar);

  let deletedFromKeychain = false;

  try {
    deletedFromKeychain = await keytar.deletePassword(SERVICE_NAME, providerId);
  } catch (error) {
    deletedFromKeychain = false;
  }

  delete process.env[envVar];

  return deletedFromKeychain;
}

module.exports = {
  loadAllKeysIntoEnv,
  listConfiguredKeys,
  setKey,
  deleteKey,
};