/**
 * Privacy Policy Page
 *
 * Public-facing privacy policy for ContentPilot AI
 * Required for Shopify App Store submission
 */

import { json } from '@remix-run/node';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const appUrl = url.origin;

  return json({
    appUrl,
    lastUpdated: '2026-01-14',
    companyName: 'Patis Universe', // Update mit deinem Firmennamen
    appName: 'ContentPilot AI',
    supportEmail: 'support@patisdesign.ch', // Update mit deiner Support Email
  });
};

export default function PrivacyPolicy() {
  const { appUrl, lastUpdated, companyName, appName, supportEmail } = useLoaderData<typeof loader>();

  return (
    <div style={{
      maxWidth: '800px',
      margin: '0 auto',
      padding: '40px 20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      lineHeight: '1.6',
      color: '#333',
    }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '10px' }}>Privacy Policy</h1>
      <p style={{ color: '#666', marginBottom: '30px' }}>Last updated: {lastUpdated}</p>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>1. Introduction</h2>
        <p>
          Welcome to {appName}. This Privacy Policy explains how {companyName} ("we", "us", or "our")
          collects, uses, and protects your information when you use our Shopify application.
        </p>
        <p>
          By installing and using {appName}, you agree to the collection and use of information
          in accordance with this policy.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>2. Information We Collect</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>2.1 Store Information</h3>
        <p>When you install {appName}, we collect:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Store name and Shopify domain</li>
          <li>Store owner email address</li>
          <li>Store URL and basic store settings</li>
          <li>OAuth access tokens (securely stored and encrypted)</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>2.2 Content Data</h3>
        <p>To provide our AI-powered content services, we access and temporarily process:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Product descriptions, titles, and metadata</li>
          <li>Collection information</li>
          <li>Blog articles and pages</li>
          <li>Store policies</li>
          <li>Theme content and translations</li>
          <li>Navigation menus</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>2.3 Usage Data</h3>
        <p>We collect information about how you use the app:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Features used and actions performed</li>
          <li>Translation and content generation requests</li>
          <li>API usage and performance metrics</li>
          <li>Error logs and debugging information</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>2.4 Subscription Information</h3>
        <p>If you subscribe to a paid plan:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Subscription plan and billing cycle</li>
          <li>Payment status (processed by Shopify)</li>
          <li>Usage limits and current usage</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>3. How We Use Your Information</h2>
        <p>We use the collected information for:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>Service Delivery:</strong> To provide AI-powered content creation and translation services</li>
          <li><strong>Content Processing:</strong> To analyze, translate, and improve your store content</li>
          <li><strong>Feature Improvement:</strong> To enhance app functionality and user experience</li>
          <li><strong>Technical Support:</strong> To troubleshoot issues and provide customer support</li>
          <li><strong>Billing Management:</strong> To process subscriptions and manage plan limits</li>
          <li><strong>Security:</strong> To detect and prevent fraud, abuse, and security issues</li>
          <li><strong>Compliance:</strong> To comply with legal obligations and enforce our terms</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>4. Third-Party Services</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.1 AI Service Providers</h3>
        <p>
          {appName} uses third-party AI services to process your content. Your content may be
          sent to one or more of the following providers:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>Hugging Face:</strong> For AI-powered text generation and translation</li>
          <li><strong>Google Gemini:</strong> For advanced language processing</li>
          <li><strong>OpenAI:</strong> For content generation (if configured)</li>
          <li><strong>Anthropic Claude:</strong> For content generation (if configured)</li>
        </ul>
        <p>
          These services process content temporarily to generate responses and do not store
          your content permanently. Please review their respective privacy policies:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Hugging Face: <a href="https://huggingface.co/privacy" target="_blank" rel="noopener">https://huggingface.co/privacy</a></li>
          <li>Google: <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">https://policies.google.com/privacy</a></li>
          <li>OpenAI: <a href="https://openai.com/privacy" target="_blank" rel="noopener">https://openai.com/privacy</a></li>
          <li>Anthropic: <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener">https://www.anthropic.com/privacy</a></li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.2 Shopify Platform</h3>
        <p>
          {appName} is built on the Shopify platform. Your store data is stored in accordance
          with <a href="https://www.shopify.com/legal/privacy" target="_blank" rel="noopener">Shopify's Privacy Policy</a>.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.3 Hosting & Infrastructure</h3>
        <p>
          Our application is hosted on Railway.app, which provides secure cloud infrastructure.
          Data is stored in encrypted databases within the EU region.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>5. Data Storage and Security</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>5.1 Data Storage</h3>
        <p>We store the following data in our secure database:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Store credentials (encrypted)</li>
          <li>AI provider API keys (encrypted with AES-256)</li>
          <li>Cached content for performance optimization</li>
          <li>Subscription and billing information</li>
          <li>Usage statistics and logs</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>5.2 Security Measures</h3>
        <p>We implement industry-standard security practices:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>SSL/TLS encryption for all data in transit</li>
          <li>AES-256 encryption for sensitive data at rest</li>
          <li>Secure OAuth 2.0 authentication</li>
          <li>Regular security audits and updates</li>
          <li>Access controls and authentication</li>
          <li>Automated backups</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>5.3 Data Retention</h3>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>Active Subscriptions:</strong> Data is retained while your app is installed</li>
          <li><strong>Cached Content:</strong> Automatically cleaned up after 30 days</li>
          <li><strong>After Uninstall:</strong> Most data is deleted within 30 days</li>
          <li><strong>Legal Requirements:</strong> Some data may be retained longer for compliance</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>6. Data Sharing and Disclosure</h2>
        <p>We do NOT sell, rent, or trade your data. We only share data in the following circumstances:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>With AI Providers:</strong> Only the content necessary for processing</li>
          <li><strong>With Shopify:</strong> As required by the Shopify platform</li>
          <li><strong>Legal Requirements:</strong> If required by law or legal process</li>
          <li><strong>Business Transfer:</strong> In the event of a merger or acquisition</li>
          <li><strong>With Your Consent:</strong> Any other sharing only with your explicit permission</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>7. Your Rights (GDPR & Privacy)</h2>
        <p>You have the following rights regarding your data:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>Access:</strong> Request a copy of your data</li>
          <li><strong>Correction:</strong> Request correction of inaccurate data</li>
          <li><strong>Deletion:</strong> Request deletion of your data (uninstall the app)</li>
          <li><strong>Export:</strong> Request a machine-readable export of your data</li>
          <li><strong>Restriction:</strong> Request limitation of data processing</li>
          <li><strong>Objection:</strong> Object to certain types of processing</li>
          <li><strong>Portability:</strong> Transfer your data to another service</li>
        </ul>
        <p>
          To exercise these rights, please contact us at <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>8. Cookies and Tracking</h2>
        <p>
          {appName} uses minimal cookies and tracking:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>Session Cookies:</strong> Required for authentication and app functionality</li>
          <li><strong>Shopify Cookies:</strong> Set by the Shopify platform</li>
          <li><strong>No Third-Party Tracking:</strong> We do not use third-party analytics or advertising cookies</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>9. International Data Transfers</h2>
        <p>
          Your data is primarily stored in EU data centers. If you are located outside the EU,
          your data may be transferred to and processed in the EU. We ensure appropriate
          safeguards are in place for such transfers.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>10. Children's Privacy</h2>
        <p>
          {appName} is not intended for use by individuals under 18 years of age. We do not
          knowingly collect personal information from children.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>11. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of any
          material changes by:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Updating the "Last Updated" date at the top</li>
          <li>Sending a notification within the app</li>
          <li>Sending an email to your store's email address</li>
        </ul>
        <p>
          Continued use of the app after changes constitutes acceptance of the updated policy.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>12. Contact Information</h2>
        <p>
          If you have questions or concerns about this Privacy Policy or our data practices,
          please contact us:
        </p>
        <div style={{
          background: '#f5f5f5',
          padding: '20px',
          borderRadius: '8px',
          marginTop: '15px',
        }}>
          <p style={{ margin: '5px 0' }}><strong>{companyName}</strong></p>
          <p style={{ margin: '5px 0' }}>Email: <a href={`mailto:${supportEmail}`}>{supportEmail}</a></p>
          <p style={{ margin: '5px 0' }}>App URL: <a href={appUrl}>{appUrl}</a></p>
        </div>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>13. Shopify App Store Requirements</h2>
        <p>
          This app complies with <a href="https://shopify.dev/docs/apps/store/requirements" target="_blank" rel="noopener">
          Shopify's App Store Requirements</a> and <a href="https://www.shopify.com/legal/api-terms" target="_blank" rel="noopener">
          Shopify API Terms</a>.
        </p>
      </section>

      <hr style={{ margin: '40px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

      <footer style={{ textAlign: 'center', color: '#666', fontSize: '0.9rem' }}>
        <p>© 2026 {companyName}. All rights reserved.</p>
        <p>
          <a href={appUrl} style={{ color: '#2c6ecb', textDecoration: 'none' }}>Back to App</a>
          {' | '}
          <a href="/terms" style={{ color: '#2c6ecb', textDecoration: 'none' }}>Terms of Service</a>
        </p>
      </footer>
    </div>
  );
}
