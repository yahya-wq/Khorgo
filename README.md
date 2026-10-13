# 🤖 Khorgo

**Agent de développement IA autonome en ligne de commande** — Une alternative open source à Claude Code.

Khorgo permet à un modèle de langage (GPT-4, Claude, Gemini, etc.) d'interagir avec votre système de fichiers local et d'exécuter des commandes pour accomplir des tâches de développement de manière autonome.

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![License](https://img.shields.io/badge/license-ISC-blue)
![Status](https://img.shields.io/badge/status-beta-orange)

---

## ✨ Fonctionnalités

### 🧠 Multi-fournisseurs IA
- **OpenAI** (GPT-4, GPT-3.5)
- **Anthropic** (Claude 3, Claude 2)
- **Google Gemini** (Gemini Pro, Gemini Ultra)
- **OpenRouter** (accès à des centaines de modèles)

### 🛠️ Outils intégrés
L'agent dispose d'outils pour interagir avec votre environnement :

- **`read_file`** — Lecture de fichiers (avec support de plages de lignes)
- **`write_file`** — Création et remplacement de fichiers
- **`edit_file`** — Modification ciblée d'extraits de code
- **`list_files`** — Exploration de l'arborescence
- **`search_files`** — Recherche par regex (style grep)
- **`run_command`** — Exécution de commandes (node, npm, git, python, etc.)

### 🖥️ Double interface
- **CLI** — Terminal interactif avec commandes avancées
- **Web** — Interface graphique moderne avec éditeur de code intégré

### 🔒 Sécurité renforcée
- **Workspace borné** — L'agent ne peut pas sortir du dossier de travail
- **Fichiers protégés** — Le code source de l'agent est invisible
- **Commandes filtrées** — Liste blanche + blocage des motifs dangereux
- **Stockage sécurisé** — Clés API dans le trousseau système (Keychain/Credential Manager)

---

## 📦 Installation

### Prérequis
- **Node.js** >= 18
- **npm** ou **yarn**

### Installation globale

```bash
npm install -g khorgo
```

### Installation depuis les sources

```bash
git clone https://github.com/yahya-wq/Khorgo.git
cd Khorgo
npm install
```

---

## 🔑 Configuration des clés API

Khorgo supporte plusieurs fournisseurs. Vous devez configurer au moins une clé API.

### Méthode 1 : Via l'interface (recommandé)

**En mode CLI :**
```bash
khorgo
# Puis tapez : /keys
```

**En mode Web :**
Cliquez sur le bouton 🔑 **Clés API** dans l'interface.

### Méthode 2 : Via fichier `.env`

Créez un fichier `.env` à la racine du projet :

```env
# OpenAI
OPENAI_API_KEY=sk-...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
GOOGLE_API_KEY=AI...

# OpenRouter
OPENROUTER_API_KEY=sk-or-...
```

⚠️ **Important** : Les clés stockées dans le trousseau système (via `/keys`) ont priorité sur le fichier `.env`.

---

## 🚀 Utilisation

### Mode CLI (Terminal)

```bash
# Lancer l'agent
khorgo

# Ou depuis les sources
npm start
```

L'agent vous demandera :
1. Le dossier de travail
2. Le fournisseur et modèle à utiliser

Ensuite, tapez vos demandes en langage naturel :

```
❯ Crée un serveur Express avec une route /api/users qui retourne une liste d'utilisateurs
❯ Ajoute des tests unitaires pour le fichier utils.js
❯ Corrige le bug dans la fonction calculateTotal
```

### Mode Web (Interface graphique)

```bash
# Lancer le serveur web
node server.js
```

Puis ouvrez votre navigateur sur **http://localhost:3000**

L'interface web offre :
- Chat interactif avec l'agent
- Éditeur de code intégré
- Gestion des clés API
- Sélection de modèles
- Visualisation des outils utilisés

---

## 📋 Commandes CLI

| Commande | Description |
|----------|-------------|
| `/help` | Afficher l'aide |
| `/status` | Afficher le statut de la session |
| `/model` | Changer de fournisseur/modèle |
| `/keys` | Gérer les clés API |
| `/workspace` | Changer de dossier de travail |
| `/auto` | Activer/désactiver le mode auto-accept |
| `/clear` | Effacer le terminal |
| `/exit` | Quitter l'agent |

### Mode auto-accept

Par défaut, Khorgo demande confirmation avant chaque écriture de fichier ou exécution de commande. Activez le mode auto-accept pour automatiser :

```
❯ /auto
✅ Mode auto-accept ACTIVÉ
```

⚠️ **Attention** : Utilisez ce mode avec précaution, surtout sur des projets importants.

---

## 🏗️ Architecture

```
Khorgo/
├── agent.js              # Cœur de l'agent (outils, boucle interactive)
├── server.js             # Serveur web Express + Socket.IO
├── modelManager.js       # Gestion des fournisseurs IA
├── keyStore.js           # Stockage sécurisé des clés API
├── bin/
│   └── khorgo.js         # Point d'entrée CLI
├── public/               # Interface web
│   ├── index.html
│   ├── app.js
│   └── style.css
└── package.json
```

### Flux de fonctionnement

1. **Entrée utilisateur** → Demande en langage naturel
2. **Analyse** → Envoi au modèle IA avec contexte
3. **Planification** → Le modèle décide quels outils utiliser
4. **Exécution** → Les outils sont appelés (lecture, écriture, commandes)
5. **Feedback** → Les résultats sont renvoyés au modèle
6. **Itération** → Le processus se répète jusqu'à completion

---

## 🔐 Sécurité

Khorgo implémente plusieurs couches de sécurité :

### Sandbox de fichiers
- L'agent ne peut accéder qu'au dossier de travail et ses sous-dossiers
- Impossible de sortir via des chemins relatifs (`../../`) ou des symlinks
- Les fichiers système de l'agent sont protégés (`agent.js`, `server.js`, etc.)

### Filtrage des commandes
- **Liste blanche** : Seules certaines commandes de base sont autorisées (node, npm, git, python, etc.)
- **Blocage de motifs dangereux** : `rm -rf /`, `sudo`, `chmod 777`, etc.
- **Pas de substitution** : Les backticks et `$()` sont bloqués
- **Pas d'eval inline** : `node -e` et `python -c` sont interdits

### Réseau
- Le serveur web écoute uniquement sur `127.0.0.1` (localhost)
- Vérification de l'origine WebSocket pour prévenir le cross-site hijacking

### Stockage des clés
- Les clés API sont stockées dans le trousseau système (Keychain sur macOS, Credential Manager sur Windows, libsecret sur Linux)
- Fallback sur `.env` si le trousseau est indisponible
- Les clés sont masquées dans l'interface (`••••••abcd`)

---

## 🧪 Développement

### Lancer en mode développement

```bash
# Mode CLI
npm run agent

# Mode Web
node server.js

# Vérifier la syntaxe
npm run check
```

### Structure du code

Le code est très commenté. Chaque décision importante est documentée avec des blocs `🔴 CORRECTION` expliquant les bugs corrigés et les raisons des choix d'implémentation.

### Ajouter un nouvel outil

1. Définir la fonction dans `agent.js`
2. L'ajouter au tableau `TOOLS` avec sa description
3. L'implémenter dans chaque `runTask*()` (OpenAI, Anthropic, Google)

---

## 🤝 Contribution

Les contributions sont les bienvenues ! Voici comment participer :

1. **Fork** le projet
2. Créez une branche (`git checkout -b feature/AmazingFeature`)
3. **Commit** vos changements (`git commit -m 'Add AmazingFeature'`)
4. **Push** vers la branche (`git push origin feature/AmazingFeature`)
5. Ouvrez une **Pull Request**

### Idées d'amélioration

- [ ] Support MCP (Model Context Protocol)
- [ ] Mémoire persistante entre sessions
- [ ] Éditeur de code avec coloration syntaxique (Monaco)
- [ ] Terminal intégré dans l'interface web
- [ ] Système de plugins pour outils personnalisés
- [ ] Tests unitaires complets
- [ ] Support de plus de fournisseurs IA

---

## 📄 Licence

Distribué sous licence ISC. Voir `LICENSE` pour plus d'informations.

---

## 🙏 Remerciements

- **OpenAI**, **Anthropic**, **Google** pour leurs APIs
- La communauté open source pour les bibliothèques utilisées
- Tous les contributeurs et testeurs

---

## 📞 Contact

**yahya-wq** — [GitHub](https://github.com/yahya-wq)

Projet : [https://github.com/yahya-wq/Khorgo](https://github.com/yahya-wq/Khorgo)

---

## ⚠️ Avertissement

Khorgo est un outil puissant qui peut modifier vos fichiers et exécuter des commandes. Utilisez-le avec précaution :

- **Testez d'abord** sur des projets non critiques
- **Utilisez Git** pour pouvoir annuler les modifications
- **Vérifiez les actions** avant de valider (sauf en mode auto-accept)
- **Ne partagez jamais** vos clés API

L'auteur ne peut être tenu responsable des dommages causés par une utilisation inappropriée.

---

<div align="center">

**Fait avec ❤️ par yahya-wq**

⭐ Starrez ce repo si vous le trouvez utile !

</div>
