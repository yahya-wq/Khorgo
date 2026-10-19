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

// On teste le VRAI safePath (safePath.js), plus une copie.
const { createSafePath } = require('../safePath');

// Un seul guard par workspace, comme dans agent.js (le cache de la racine
// vit dans le guard : le recréer à chaque appel fausserait les mesures).
const guards = new Map();
function safePath(filePath, workspace) {
  let guard = guards.get(workspace);
  if (!guard) {
    guard = createSafePath(() => workspace);
    guards.set(workspace, guard);
  }
  return guard(filePath);
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

    it('devrait autoriser un fichier nommé agent.js dans un sous-dossier (fichier utilisateur)', () => {
      fs.mkdirSync(path.join(testWorkspace, 'subdir2'), { recursive: true });
      fs.writeFileSync(path.join(testWorkspace, 'subdir2', 'agent.js'), 'test');

      assert.doesNotThrow(() => safePath('subdir2/agent.js', testWorkspace));
    });

    it('devrait bloquer .env et .git à toute profondeur', () => {
      fs.mkdirSync(path.join(testWorkspace, 'pkg', '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(testWorkspace, 'pkg', '.env'), 'SECRET=1');

      assert.throws(() => safePath('pkg/.env', testWorkspace), /code source interne/);
      assert.throws(() => safePath('pkg/.env.local', testWorkspace), /code source interne/);
      assert.throws(() => safePath('pkg/.git/hooks/pre-commit', testWorkspace), /code source interne/);
      assert.throws(() => safePath('pkg/node_modules/x/index.js', testWorkspace), /code source interne/);
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

    it('devrait bloquer un symlink dangling pointant hors du workspace', function() {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'khorgo-outside-'));
      const link = path.join(testWorkspace, 'dangling-link');
      try {
        fs.symlinkSync(path.join(outside, 'nouveau-fichier'), link);
      } catch (e) {
        return this.skip ? this.skip() : undefined; // symlinks indisponibles (Windows sans droits)
      }
      // La cible n'existe pas encore : écrire via ce lien créerait un fichier hors workspace.
      assert.throws(() => safePath('dangling-link', testWorkspace));
      fs.unlinkSync(link);
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

// 100 ms / 1000 appels sous Linux/macOS. Windows : realpathSync est bien plus
// lent (antivirus, chemins 8.3) ; le seuil sert juste à détecter une régression
// grossière, pas à mesurer la vitesse (safePath est appelé une fois par outil).
const LIMIT_MS = process.platform === 'win32' ? 10000 : 100;

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

        assert.ok(durationMs < LIMIT_MS, `Performance insuffisante : ${durationMs}ms pour 1000 appels (limite ${LIMIT_MS}ms)`);
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

        assert.ok(durationMs < LIMIT_MS, `Performance insuffisante : ${durationMs}ms pour 1000 rejets (limite ${LIMIT_MS}ms)`);
  });
});

console.log('\n🧪 Tests unitaires pour safePath()\n');
console.log('Exécution : node --test tests/safePath.test.js\n');