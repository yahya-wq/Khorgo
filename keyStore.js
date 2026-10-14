"use strict";

















const keytar = require("keytar");
const fs = require("fs");
const path = require("path");

const SERVICE_NAME = "khorgo-agent";



const ENV_PATH = path.join(process.cwd(), ".env");







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

    return false;
  }

  return true;
}







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



    }
  }
}






async function listConfiguredKeys() {
  const statuses = [];

  for (const { provider, label, envVar } of PROVIDERS) {
    let configured = false;
    let masked = null;
    let source = null;

    if (envKeysAtStartup.has(provider)) {

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


      }
    }

    statuses.push({ provider, label, envVar, configured, masked, source });
  }

  return statuses;
}






async function setKey(providerId, apiKey) {
  const { envVar } = getProviderConfig(providerId);

  if (!apiKey || !apiKey.trim()) {
    throw new Error("La clé API ne peut pas être vide.");
  }

  const trimmedKey = apiKey.trim();




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