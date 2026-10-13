#!/usr/bin/env node
const { exec } = require("child_process");

// Lance le serveur web (interface graphique Khorgo), qui lui-même
// démarre l'agent en sous-processus. C'est la même chose que
// "node server.js", mais accessible via la commande globale "khorgo".
require("../server.js");

const PORT = process.env.PORT || 3000;
const url = `http://localhost:${PORT}`;

// Ouvre automatiquement le navigateur une fois le serveur prêt.
// Si ça échoue (environnement sans interface graphique, serveur distant...),
// l'utilisateur peut toujours ouvrir l'URL manuellement.
setTimeout(() => {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      console.log(`👉 Ouvre manuellement ton navigateur sur ${url}`);
    }
  });
}, 1000);