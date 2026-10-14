#!/usr/bin/env node
/**
 * Script pour exécuter les tests unitaires de Khorgo
 *
 * Usage : node tests/run-tests.js
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('🧪 Exécution des tests unitaires Khorgo\n');
console.log('─'.repeat(50));

try {
  // Exécuter tous les tests
  const testFiles = [
    'tests/safePath.test.js'
  ];

  for (const testFile of testFiles) {
    console.log(`\n📄 ${testFile}\n`);

    try {
      execSync(`node --test ${testFile}`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..')
      });
    } catch (error) {
      console.error(`\n❌ Tests échoués dans ${testFile}`);
      process.exit(1);
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log('\n✅ Tous les tests ont réussi !\n');
} catch (error) {
  console.error('\n❌ Erreur lors de l\'exécution des tests :', error.message);
  process.exit(1);
}
