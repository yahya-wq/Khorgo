# Tests unitaires Khorgo

Ce dossier contient les tests unitaires pour Khorgo, en particulier pour la fonction critique `safePath()` qui gère la sécurité du bac à sable (sandbox).

## 🧪 Exécuter les tests

### Option 1 : Script dédié (recommandé)
```bash
node tests/run-tests.js
```

### Option 2 : Node.js natif
```bash
node --test tests/safePath.test.js
```

### Option 3 : Tous les tests d'un coup
```bash
node --test tests/*.test.js
```

## 📋 Tests inclus

### `safePath.test.js` - Tests de sécurité (45+ cas)

#### ✅ Chemins valides
- Chemins relatifs simples
- Chemins dans les sous-dossiers
- Chemins absolus dans le workspace
- Workspace lui-même
- Création automatique des dossiers parents

#### 🛡️ Protection contre le traversal
- `../../etc/passwd`
- `../../../etc/passwd`
- Chemins absolus hors du workspace
- Traversal via sous-dossiers
- Traversal multi-niveaux

#### 🔒 Protection des fichiers internes
- `agent.js`
- `.env`
- `node_modules`
- `package.json`
- Insensibilité à la casse
- Accès via sous-dossiers

#### 💉 Protection contre les injections
- Caractères nuls (`\0`)
- Chemins vides
- Chemins null/undefined

#### 🔗 Protection contre les symlinks
- Symlinks pointant hors du workspace
- Symlinks valides dans le workspace

#### ⚡ Cas limites
- Espaces dans les chemins
- Caractères spéciaux
- Chemins très longs
- Slashes multiples
- Points (`./`, `../`)

#### 🚀 Performance
- 1000 appels rapides (< 100ms)
- 1000 rejets rapides (< 100ms)

## 📊 Couverture

Les tests couvrent :
- ✅ Tous les vecteurs d'attaque connus
- ✅ Cas limites et edge cases
- ✅ Performance
- ✅ Compatibilité Windows (si applicable)

## 🎯 Ajouter de nouveaux tests

Pour ajouter des tests :

1. Crée un nouveau fichier `tests/nom.test.js`
2. Utilise le framework `node:test` natif
3. Suis la structure existante
4. Ajoute le fichier dans `tests/run-tests.js`

Exemple :
```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Ma fonctionnalité', () => {
  it('devrait faire ceci', () => {
    assert.strictEqual(resultat, attendu);
  });
});
```

## 🔧 Dépendances

Aucune dépendance externe nécessaire ! Les tests utilisent :
- `node:test` (framework natif Node.js 18+)
- `node:assert` (assertions natives)
- Modules Node.js standard (`fs`, `path`, `os`)

## 📝 Notes

- Les tests créent un workspace temporaire dans `/tmp`
- Le workspace est automatiquement nettoyé après les tests
- Les tests de symlinks sont ignorés sur Windows si les privilèges sont insuffisants
- Les tests Windows ne s'exécutent que sur Windows
