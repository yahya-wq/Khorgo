require("dotenv").config();

const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const Anthropic = require("@anthropic-ai/sdk");

// ==========================================
// VÉRIFIER SI UNE CLÉ API EST DISPONIBLE
// ==========================================

function hasApiKey(provider) {
  const keys = {
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY"
  };

  const envName = keys[provider];

  if (!envName) {
    return false;
  }

  return Boolean(process.env[envName]);
}


// ==========================================
// FOURNISSEURS DISPONIBLES
// ==========================================

function getAvailableProviders() {
  const providers = [
    {
      id: "openai",
      name: "OpenAI"
    },
    {
      id: "google",
      name: "Google Gemini"
    },
    {
      id: "anthropic",
      name: "Anthropic"
    },
    {
      id: "openrouter",
      name: "OpenRouter"
    }
  ];

  return providers.filter(provider =>
    hasApiKey(provider.id)
  );
}

async function getOpenRouterModels() {
  if (!hasApiKey("openrouter")) {
    return [];
  }

  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1"
  });

  const response = await client.models.list();

  return response.data.map(model => ({
    id: model.id,
    name: model.name || model.id
  }));
}

async function getOpenAIModels() {
  if (!hasApiKey("openai")) {
    return [];
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const response = await client.models.list();

  // L'API OpenAI ne renvoie pas de "nom d'affichage" séparé,
  // seulement un id (ex: "gpt-5", "whisper-1", "text-embedding-3-large").
  // Tous les modèles du compte sont renvoyés, pas seulement ceux
  // compatibles chat.completions.
  return response.data.map(model => ({
    id: model.id,
    name: model.id
  }));
}

async function getGoogleModels() {
  if (!hasApiKey("google")) {
    return [];
  }

  const client = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY
  });

  // client.models.list() renvoie un "Pager" (itérable en pages),
  // pas un tableau directement.
  const pager = await client.models.list();
  const models = [];

  for await (const model of pager) {
    models.push({
      // Le SDK renvoie souvent un id du type "models/gemini-2.5-pro".
      // On enlève le préfixe "models/" pour rester cohérent avec
      // le format utilisé ailleurs (ex: models.js).
      id: (model.name || "").replace(/^models\//, ""),
      name: model.displayName || model.name
    });
  }

  return models;
}

async function getAnthropicModels() {
  if (!hasApiKey("anthropic")) {
    return [];
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const response = await client.models.list();

  return response.data.map(model => ({
    id: model.id,
    name: model.display_name || model.id
  }));
}

async function getAvailableModels(provider) {
  switch (provider) {
    case "openrouter":
      return await getOpenRouterModels();

    case "openai":
      return await getOpenAIModels();

    case "google":
      return await getGoogleModels();

    case "anthropic":
      return await getAnthropicModels();

    default:
      throw new Error(
        `La récupération des modèles pour ${provider} n'est pas encore implémentée.`
      );
  }
}


// ==========================================
// CRÉER UN CLIENT
// ==========================================

function getModel(provider, model) {

  switch (provider) {

    // =========================
    // OPENAI
    // =========================

    case "openai": {

      if (!hasApiKey("openai")) {
        throw new Error("OPENAI_API_KEY est manquante.");
      }

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      return {
        provider: "openai",
        model,
        client
      };
    }


    // =========================
    // GOOGLE GEMINI
    // =========================

    case "google": {

      if (!hasApiKey("google")) {
        throw new Error("GOOGLE_API_KEY est manquante.");
      }

      const client = new GoogleGenAI({
        apiKey: process.env.GOOGLE_API_KEY
      });

      return {
        provider: "google",
        model,
        client
      };
    }


    // =========================
    // ANTHROPIC
    // =========================

    case "anthropic": {

      if (!hasApiKey("anthropic")) {
        throw new Error("ANTHROPIC_API_KEY est manquante.");
      }

      const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });

      return {
        provider: "anthropic",
        model,
        client
      };
    }


    // =========================
    // OPENROUTER
    // =========================

    case "openrouter": {

      if (!hasApiKey("openrouter")) {
        throw new Error("OPENROUTER_API_KEY est manquante.");
      }

      const client = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1"
      });

      return {
        provider: "openrouter",
        model,
        client
      };
    }


    // =========================
    // FOURNISSEUR INCONNU
    // =========================

    default:
      throw new Error(
        `Fournisseur inconnu : ${provider}`
      );
  }
}


module.exports = {
  getModel,
  hasApiKey,
  getAvailableProviders,
  getAvailableModels
};