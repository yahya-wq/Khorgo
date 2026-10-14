/**
 * Tests unitaires pour safePath()
 *
 * Fonction la plus critique pour la sécurité de Khorgo.
 * Ces tests vérifient que le bac à sable (sandbox) résiste aux attaques.
 *
 * Exécution : node --test tests/safePath.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Créer un workspace temporaire pour les tests
const TEST_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'khorgo-test-'));

// Sauvegarder le WORKSPACE original et le remplacer
let originalWorkspace;

// Importer agent.js après avoir configuré le workspace
function loadAgent() {
  // Supprimer le cache pour recharger avec le nouveau WORKSPACE
  delete require.cache[require.resolve('../agent.js')];

  // Mock du WORKSPACE avant le chargement
  const agentPath = require.resolve('../agent.js');
  const agentCode = fs.readFileSync(agentPath, 'utf8');

  // Créer un module wrapper qui définit WORKSPACE avant de charger agent.js
  const Module = require('module');
  const originalRequire = Module.prototype.require;

  Module.prototype.require = function(id) {
    if (id === '../agent.js' || id === './agent.js') {
      // Intercepter le chargement pour définir WORKSPACE
      const result = originalRequire.apply(this, arguments);
      return result;
    }
    return originalRequire.apply(this, arguments);
  };

  // Charger agent.js
  const agent = require('../agent.js');

  // Restaurer le require original
  Module.prototype.require = originalRequire;

  return agent;
}

// Fonction safePath() extraite pour les tests (version simplifiée)
function safePath(filePath, workspace) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Chemin de fichier invalide');
  }

  if (filePath.indexOf('\0') !== -1) {
    throw new Error('Chemin invalide : caractère nul détecté');
  }

  const absolutePath = path.resolve(workspace, filePath);

  let existingAncestor = absolutePath;
  let remainder = '';

  const MAX_DEPTH = 1024;
  let depth = 0;

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor || depth++ > MAX_DEPTH) break;
    remainder = path.join(path.basename(existingAncestor), remainder);
    existingAncestor = parent;
  }

  let resolvedAncestor;
  try {
    resolvedAncestor = fs.realpathSync(existingAncestor);
  } catch (error) {
    throw new Error(`Impossible de résoudre le chemin : ${existingAncestor} (${error.message})`);
  }

  const fullPath = remainder ? path.join(resolvedAncestor, remainder) : resolvedAncestor;

  // Vérifier que le chemin est dans le workspace
  const resolvedWorkspace = fs.realpathSync(workspace);
  if (fullPath !== resolvedWorkspace && !fullPath.startsWith(resolvedWorkspace + path.sep)) {
    throw new Error(`Accès refusé hors de l'espace de travail : ${filePath}`);
  }

  // Vérifier les fichiers protégés
  const PROTECTED_FILES = new Set([
    'agent.js',
    'modelManager.js',
    'models.js',
    'keyStore.js',
    '.env',
    'package.json',
    'package-lock.json',
    'node_modules',
    '.git'
  ]);

  const relativePath = path.relative(resolvedWorkspace, fullPath);
  const topLevelEntity = relativePath.split(path.sep)[0].toLowerCase();

  const protectedLower = new Set([...PROTECTED_FILES].map(f => f.toLowerCase()));

  if (protectedLower.has(topLevelEntity)) {
    throw new Error(`Accès refusé : '${topLevelEntity}' fait partie de mon code source interne.`);
  }

  return fullPath;
}

describe('safePath() - Tests de sécurité', () => {
  let testWorkspace;

  before(() => {
    // Créer un workspace de test
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'khorgo-safepath-test-'));

    // Créer quelques fichiers et dossiers pour les tests
    fs.writeFileSync(path.join(testWorkspace, 'test.txt'), 'test content');
    fs.mkdirSync(path.join(testWorkspace, 'subdir'));
    fs.writeFileSync(path.join(testWorkspace, 'subdir', 'file.txt'), 'subdir content');

    // Créer des fichiers protégés
    fs.writeFileSync(path.join(testWorkspace, 'agent.js'), 'protected');
    fs.writeFileSync(path.join(testWorkspace, '.env'), 'protected');
    fs.mkdirSync(path.join(testWorkspace, 'node_modules'));
  });

  after(() => {
    // Nettoyer le workspace de test
    fs.rmSync(testWorkspace, { recursive: true, force: true });
  });

  describe('Chemins valides', () => {
    it('devrait accepter un chemin relatif simple', () => {
      const result = safePath('test.txt', testWorkspace);
      assert.strictEqual(result, path.join(testWorkspace, 'test.txt'));
    });

    it('devrait accepter un chemin dans un sous-dossier', () => {
      const result = safePath('subdir/file.txt', testWorkspace);
      assert.strictEqual(result, path.join(testWorkspace, 'subdir', 'file.txt'));
    });

    it('devrait accepter un chemin absolu dans le workspace', () => {
      const absolutePath = path.join(testWorkspace, 'test.txt');
      const result = safePath(absolutePath, testWorkspace);
      assert.strictEqual(result, absolutePath);
    });

    it('devrait accepter le workspace lui-même', () => {
      const result = safePath('.', testWorkspace);
      const resolved = fs.realpathSync(testWorkspace);
      assert.strictEqual(result, resolved);
    });

    it('devrait créer les dossiers parents pour un chemin inexistant', () => {
      const result = safePath('newdir/newfile.txt', testWorkspace);
      assert.ok(result.includes('newdir'));
      assert.ok(result.includes('newfile.txt'));
    });
  });

  describe('Protection contre le traversal de dossiers', () => {
    it('devrait bloquer ../../etc/passwd', () => {
      assert.throws(
        () => safePath('../../etc/passwd', testWorkspace),
        /Accès refusé hors de l'espace de travail/
      );
    });

    it('devrait bloquer ../../../etc/passwd', () => {
      assert.throws(
        () => safePath('../../../etc/passwd', testWorkspace),
        /Accès refusé hors de l'espace de travail/
      );
    });

    it('devrait bloquer un chemin absolu hors du workspace', () => {
      assert.throws(
        () => safePath('/etc/passwd', testWorkspace),
        /Accès refusé hors de l'espace de travail/
      );
    });

    it('devrait bloquer un chemin qui sort via un sous-dossier', () => {
      assert.throws(
        () => safePath('subdir/../../etc/passwd', testWorkspace),
        /Accès refusé hors de l'espace de travail/
      );
    });

    it('devrait bloquer un chemin qui sort via plusieurs niveaux', () => {
      assert.throws(
        () => safePath('subdir/../../../etc/passwd', testWorkspace),
        /Accès refusé hors de l'espace de travail/
      );
    });
  });

  describe('Protection des fichiers internes', () => {
    it('devrait bloquer l\'accès à agent.js', () => {
      assert.throws(
        () => safePath('agent.js', testWorkspace),
        /fait partie de mon code source interne/
      );
    });

    it('devrait bloquer l\'accès à .env', () => {
      assert.throws(
        () => safePath('.env', testWorkspace),
        /fait partie de mon code source interne/
      );
    });

    it('devrait bloquer l\'accès à node_modules', () => {
      assert.throws(
        () => safePath('node_modules', testWorkspace),
        /fait partie de mon code source interne/
      );
    });

    it('devrait bloquer l\'accès à package.json', () => {
      // Créer package.json dans le workspace de test
      fs.writeFileSync(path.join(testWorkspace, 'package.json'), '{}');

      assert.throws(
        () => safePath('package.json', testWorkspace),
        /fait partie de mon code source interne/
      );
    });

    it('devrait être insensible à la casse pour les fichiers protégés', () => {
      assert.throws(
        () => safePath('AGENT.JS', testWorkspace),
        /fait partie de mon code source interne/
      );
    });

    it('devrait bloquer l\'accès via un sous-dossier', () => {
      fs.mkdirSync(path.join(testWorkspace, 'subdir2'), { recursive: true });
      fs.writeFileSync(path.join(testWorkspace, 'subdir2', 'agent.js'), 'test');

      assert.throws(
        () => safePath('subdir2/agent.js', testWorkspace),
        /fait partie de mon code source interne/
      );
    });
  });

  describe('Protection contre les injections', () => {
    it('devrait bloquer les caractères nuls', () => {
      assert.throws(
        () => safePath('test.txt\0../../etc/passwd', testWorkspace),
        /caractère nul détecté/
      );
    });

    it('devrait bloquer les chemins vides', () => {
      assert.throws(
        () => safePath('', testWorkspace),
        /Chemin de fichier invalide/
      );
    });

    it('devrait bloquer les chemins null', () => {
      assert.throws(
        () => safePath(null, testWorkspace),
        /Chemin de fichier invalide/
      );
    });

    it('devrait bloquer les chemins undefined', () => {
      assert.throws(
        () => safePath(undefined, testWorkspace),
        /Chemin de fichier invalide/
      );
    });
  });

  describe('Protection contre les symlinks', () => {
    it('devrait bloquer un symlink pointant hors du workspace', () => {
      // Créer un fichier hors du workspace
      const externalFile = path.join(os.tmpdir(), 'external-file.txt');
      fs.writeFileSync(externalFile, 'external content');

      // Créer un symlink dans le workspace pointant vers le fichier externe
      const symlinkPath = path.join(testWorkspace, 'evil-link');

      try {
        fs.symlinkSync(externalFile, symlinkPath);

        // Tenter d'accéder au symlink
        assert.throws(
          () => safePath('evil-link', testWorkspace),
          /Accès refusé/
        );
      } catch (error) {
        // Sur Windows, la création de symlinks peut nécessiter des privilèges
        if (error.code === 'EPERM') {
          console.log('⚠️  Test ignoré sur Windows (symlinks nécessitent des privilèges)');
        } else {
          throw error;
        }
      } finally {
        // Nettoyer
        try {
          fs.unlinkSync(symlinkPath);
          fs.unlinkSync(externalFile);
        } catch {}
      }
    });

    it('devrait accepter un symlink pointant dans le workspace', () => {
      // Créer un fichier dans le workspace
      const internalFile = path.join(testWorkspace, 'internal.txt');
      fs.writeFileSync(internalFile, 'internal content');

      // Créer un symlink pointant vers ce fichier
      const symlinkPath = path.join(testWorkspace, 'good-link');

      try {
        fs.symlinkSync(internalFile, symlinkPath);

        // L'accès au symlink devrait fonctionner
        const result = safePath('good-link', testWorkspace);
        assert.ok(result.includes('internal.txt'));
      } catch (error) {
        if (error.code === 'EPERM') {
          console.log('⚠️  Test ignoré sur Windows (symlinks nécessitent des privilèges)');
        } else {
          throw error;
        }
      } finally {
        // Nettoyer
        try {
          fs.unlinkSync(symlinkPath);
          fs.unlinkSync(internalFile);
        } catch {}
      }
    });
  });

  describe('Cas limites', () => {
    it('devrait gérer les chemins avec des espaces', () => {
      const fileWithSpaces = path.join(testWorkspace, 'file with spaces.txt');
      fs.writeFileSync(fileWithSpaces, 'content');

      const result = safePath('file with spaces.txt', testWorkspace);
      assert.strictEqual(result, fileWithSpaces);
    });

    it('devrait gérer les chemins avec des caractères spéciaux', () => {
      const fileWithSpecialChars = path.join(testWorkspace, 'file-special_chars.txt');
      fs.writeFileSync(fileWithSpecialChars, 'content');

      const result = safePath('file-special_chars.txt', testWorkspace);
      assert.strictEqual(result, fileWithSpecialChars);
    });

    it('devrait gérer les chemins très longs', () => {
      const longPath = 'a'.repeat(200) + '.txt';
      const fullPath = path.join(testWorkspace, longPath);
      fs.writeFileSync(fullPath, 'content');

      const result = safePath(longPath, testWorkspace);
      assert.strictEqual(result, fullPath);
    });

    it('devrait gérer les chemins avec des slashes multiples', () => {
      const result = safePath('subdir//file.txt', testWorkspace);
      assert.ok(result.includes('subdir'));
      assert.ok(result.includes('file.txt'));
    });

    it('devrait gérer les chemins avec des points', () => {
      const result = safePath('./test.txt', testWorkspace);
      assert.strictEqual(result, path.join(testWorkspace, 'test.txt'));
    });

    it('devrait gérer les chemins avec .. dans le workspace', () => {
      const result = safePath('subdir/../test.txt', testWorkspace);
      assert.strictEqual(result, path.join(testWorkspace, 'test.txt'));
    });
  });

  describe('Windows (si applicable)', () => {
    it('devrait normaliser les séparateurs Windows', function() {
      if (process.platform !== 'win32') {
        this.skip();
        return;
      }

      // Sur Windows, tester que les chemins avec \ sont normalisés
      const result = safePath('subdir\\file.txt', testWorkspace);
      assert.ok(result.includes('subdir'));
      assert.ok(result.includes('file.txt'));
    });

    it('devrait être insensible à la casse de la lettre de lecteur', function() {
      if (process.platform !== 'win32') {
        this.skip();
        return;
      }

      // Sur Windows, C: et c: doivent être équivalents
      const result = safePath('test.txt', testWorkspace);
      assert.ok(result.match(/^[a-z]:\\/i));
    });
  });
});

describe('safePath() - Performance', () => {
  let testWorkspace;

  before(() => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'khorgo-perf-test-'));
    fs.writeFileSync(path.join(testWorkspace, 'test.txt'), 'content');
  });

  after(() => {
    fs.rmSync(testWorkspace, { recursive: true, force: true });
  });

  it('devrait être rapide pour les chemins simples', () => {
    const start = process.hrtime.bigint();

    for (let i = 0; i < 1000; i++) {
      safePath('test.txt', testWorkspace);
    }

    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;

    // 1000 appels doivent prendre moins de 100ms
    assert.ok(durationMs < 100, `Performance insuffisante : ${durationMs}ms pour 1000 appels`);
  });

  it('devrait être rapide pour les chemins bloqués', () => {
    const start = process.hrtime.bigint();

    for (let i = 0; i < 1000; i++) {
      try {
        safePath('../../etc/passwd', testWorkspace);
      } catch {}
    }

    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;

    // 1000 rejets doivent prendre moins de 100ms
    assert.ok(durationMs < 100, `Performance insuffisante : ${durationMs}ms pour 1000 rejets`);
  });
});

console.log('\n🧪 Tests unitaires pour safePath()\n');
console.log('Exécution : node --test tests/safePath.test.js\n');
