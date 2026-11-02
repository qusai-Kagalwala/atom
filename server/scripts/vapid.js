// Creates a VAPID key pair for Web Push (Phase 14). Put the lines in the project's .env (next to web.config) — never in code.
// Run once: npm run vapid
const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log("Add these to the project's .env (keep the private key secret):\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:your-it-email@example.edu');
console.log('\nChanging the keys later signs every device out of push; they turn it on again in Profile.');
