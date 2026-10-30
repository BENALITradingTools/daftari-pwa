// node gen-vapid.mjs  -> prints a VAPID key pair (run once, keep the private part secret)
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
console.log('PUBLIC KEY  (goes in index.html and wrangler.toml):\n' + pub);
console.log('\nPRIVATE JWK (secret! paste when wrangler asks for VAPID_PRIVATE_JWK):\n' + JSON.stringify(jwk));
