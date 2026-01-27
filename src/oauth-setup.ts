/**
 * @deprecated LEGACY SCRIPT - LOCAL DEVELOPMENT ONLY
 *
 * This script is NOT compatible with multi-tenant SaaS deployments.
 * It uses a single hardcoded shop from environment variables.
 *
 * For production SaaS:
 * - OAuth is handled automatically by @shopify/shopify-app-remix
 * - Shop credentials are stored in the database per-tenant
 * - See app/shopify.server.ts for the production OAuth flow
 *
 * Only use this script for:
 * - Initial local development setup
 * - Testing with a single development shop
 */

import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const API_KEY = process.env.SHOPIFY_API_KEY!;
const API_SECRET = process.env.SHOPIFY_API_SECRET!;
const SCOPES = process.env.SHOPIFY_SCOPES?.split(',') || ['read_products', 'write_products'];
const SHOP = process.env.SHOPIFY_SHOP_NAME; // Optional for legacy local dev
const HOST = process.env.SHOPIFY_REDIRECT_URI || 'http://localhost:3000/api/auth/callback';
const API_VERSION = (process.env.SHOPIFY_API_VERSION || '2025-01') as ApiVersion;

if (!API_KEY || !API_SECRET) {
  console.error('❌ Fehler: SHOPIFY_API_KEY und SHOPIFY_API_SECRET müssen in der .env Datei gesetzt sein!');
  console.error('');
  console.error('⚠️  HINWEIS: Dieses Script ist nur für lokale Entwicklung gedacht.');
  console.error('   Für SaaS-Deployment wird OAuth automatisch vom Shopify App Framework gehandhabt.');
  process.exit(1);
}

if (!SHOP) {
  console.error('❌ Fehler: SHOPIFY_SHOP_NAME muss für dieses Legacy-Script gesetzt sein.');
  console.error('');
  console.error('⚠️  HINWEIS: Dieses Script ist nur für lokale Entwicklung gedacht.');
  console.error('   Für SaaS-Deployment wird OAuth automatisch vom Shopify App Framework gehandhabt.');
  process.exit(1);
}

// Initialize Shopify API
const shopify = shopifyApi({
  apiKey: API_KEY,
  apiSecretKey: API_SECRET,
  scopes: SCOPES,
  hostName: HOST.replace('http://', '').replace('https://', '').split('/')[0],
  hostScheme: 'http',
  apiVersion: API_VERSION,
  isEmbeddedApp: false,
});

const app = express();

/**
 * Step 1: Redirect user to Shopify authorization page
 */
app.get('/auth', async (req, res) => {
  try {
    console.log('🔐 Starting OAuth flow...');
    console.log('');

    await shopify.auth.begin({
      shop: `${SHOP}.myshopify.com`,
      callbackPath: '/api/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    // Note: shopify.auth.begin already handles the redirect via rawResponse
  } catch (error) {
    console.error('Auth error:', error);
    if (!res.headersSent) {
      res.status(500).send('Authorization failed: ' + error);
    }
  }
});

/**
 * Step 2: Handle OAuth callback from Shopify
 */
app.get('/api/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { session } = callback;

    if (!session || !session.accessToken) {
      throw new Error('No access token received');
    }

    console.log('');
    console.log('✅ OAuth erfolgreich!');
    console.log('');
    console.log('🔑 Dein Access Token:');
    console.log(session.accessToken);
    console.log('');

    // Save access token to .env file
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf-8');

    // Update or add SHOPIFY_ACCESS_TOKEN
    if (envContent.includes('SHOPIFY_ACCESS_TOKEN=')) {
      envContent = envContent.replace(
        /SHOPIFY_ACCESS_TOKEN=.*/,
        `SHOPIFY_ACCESS_TOKEN=${session.accessToken}`
      );
    } else {
      envContent += `\nSHOPIFY_ACCESS_TOKEN=${session.accessToken}\n`;
    }

    fs.writeFileSync(envPath, envContent);

    console.log('💾 Access Token wurde in .env gespeichert!');
    console.log('');
    console.log('✅ Setup abgeschlossen! Du kannst jetzt den Server stoppen (Ctrl+C)');
    console.log('   und npm run dev ausführen um den Connector zu nutzen.');
    console.log('');

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>OAuth Erfolgreich</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 3rem;
              border-radius: 1rem;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 500px;
            }
            h1 { color: #10b981; margin-bottom: 1rem; }
            p { color: #6b7280; line-height: 1.6; }
            .token {
              background: #f3f4f6;
              padding: 1rem;
              border-radius: 0.5rem;
              font-family: monospace;
              word-break: break-all;
              margin: 1rem 0;
              font-size: 0.875rem;
            }
            .success { font-size: 4rem; margin-bottom: 1rem; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✅</div>
            <h1>OAuth Erfolgreich!</h1>
            <p>Dein Access Token wurde erfolgreich abgerufen und in der .env Datei gespeichert.</p>
            <div class="token">${session.accessToken}</div>
            <p><strong>Nächste Schritte:</strong></p>
            <p>1. Stoppe den OAuth Server (Ctrl+C im Terminal)<br>
               2. Führe <code>npm run dev</code> aus<br>
               3. Der Connector ist jetzt einsatzbereit!</p>
          </div>
        </body>
      </html>
    `);

    // Automatically close server after 5 seconds
    setTimeout(() => {
      console.log('Server wird automatisch beendet...');
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('❌ Callback error:', error);
    res.status(500).send('Callback failed: ' + error);
  }
});

// Start server
const PORT = 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 OAuth Setup Server gestartet!');
  console.log('');
  console.log('📋 Schritte:');
  console.log('1. Öffne diese URL in deinem Browser:');
  console.log(`   👉 http://localhost:${PORT}/auth`);
  console.log('');
  console.log('2. Du wirst zu Shopify weitergeleitet');
  console.log('3. Klicke auf "Install" um die App zu autorisieren');
  console.log('4. Du wirst zurück weitergeleitet und der Access Token wird automatisch gespeichert');
  console.log('');
  console.log(`Shop: ${SHOP}.myshopify.com`);
  console.log(`Scopes: ${SCOPES.join(', ')}`);
  console.log('');
});
