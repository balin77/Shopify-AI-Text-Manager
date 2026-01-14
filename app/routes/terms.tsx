/**
 * Terms of Service Page
 *
 * Public-facing terms of service for ContentPilot AI
 * Optional but recommended for Shopify App Store
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

export default function TermsOfService() {
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
      <h1 style={{ fontSize: '2.5rem', marginBottom: '10px' }}>Terms of Service</h1>
      <p style={{ color: '#666', marginBottom: '30px' }}>Last updated: {lastUpdated}</p>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>1. Acceptance of Terms</h2>
        <p>
          By installing, accessing, or using {appName} ("the App"), you agree to be bound by
          these Terms of Service ("Terms"). If you do not agree to these Terms, do not install
          or use the App.
        </p>
        <p>
          These Terms constitute a legally binding agreement between you ("you", "your", or "Merchant")
          and {companyName} ("we", "us", or "our").
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>2. Description of Service</h2>
        <p>
          {appName} is a Shopify application that provides AI-powered content creation and
          translation services, including:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Product description generation and optimization</li>
          <li>Multi-language content translation</li>
          <li>Content management for products, collections, pages, and more</li>
          <li>Theme content translation</li>
          <li>Bulk content operations</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>3. Account and Eligibility</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>3.1 Shopify Store Required</h3>
        <p>
          To use the App, you must have an active Shopify store and comply with
          <a href="https://www.shopify.com/legal/terms" target="_blank" rel="noopener"> Shopify's Terms of Service</a>.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>3.2 Age Requirement</h3>
        <p>
          You must be at least 18 years old to use the App.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>3.3 Account Security</h3>
        <p>
          You are responsible for maintaining the security of your Shopify account and for
          all activities that occur under your account.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>4. Subscription Plans and Billing</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.1 Plans</h3>
        <p>The App offers multiple subscription plans:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li><strong>Free Plan:</strong> Limited features (15 products)</li>
          <li><strong>Basic Plan:</strong> €9.90/month (50 products)</li>
          <li><strong>Pro Plan:</strong> €19.90/month (150 products)</li>
          <li><strong>Max Plan:</strong> €49.90/month (unlimited products)</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.2 Billing</h3>
        <ul style={{ marginLeft: '20px' }}>
          <li>Subscriptions are billed monthly in advance through Shopify</li>
          <li>All prices are in EUR and exclude applicable taxes</li>
          <li>Paid plans include a 7-day free trial period</li>
          <li>After the trial, you will be charged automatically unless you cancel</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.3 Cancellation and Refunds</h3>
        <ul style={{ marginLeft: '20px' }}>
          <li>You may cancel your subscription at any time through the App</li>
          <li>Cancellations take effect at the end of the current billing period</li>
          <li>No refunds for partial months or unused services</li>
          <li>Trial cancellations result in no charges</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.4 Plan Changes</h3>
        <ul style={{ marginLeft: '20px' }}>
          <li>You may upgrade or downgrade at any time</li>
          <li>Upgrades take effect immediately</li>
          <li>Downgrades take effect at the next billing cycle</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>4.5 Price Changes</h3>
        <p>
          We reserve the right to modify pricing. You will be notified at least 30 days
          in advance of any price increases. Continued use after price changes constitutes
          acceptance of the new prices.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>5. Usage Limits and Fair Use</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>5.1 Plan Limits</h3>
        <p>Each plan has specific limits on:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Number of products</li>
          <li>Content types accessible</li>
          <li>Features available</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>5.2 Fair Use Policy</h3>
        <p>
          You agree to use the App in a reasonable manner. Excessive or abusive use,
          including automated bulk requests beyond plan limits, may result in service
          throttling or suspension.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>6. Acceptable Use</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>6.1 Permitted Use</h3>
        <p>You may use the App only for:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Legitimate business purposes related to your Shopify store</li>
          <li>Creating and translating content for your own store</li>
          <li>Managing your store's content in accordance with these Terms</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>6.2 Prohibited Use</h3>
        <p>You may NOT:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Violate any laws, regulations, or third-party rights</li>
          <li>Generate illegal, harmful, or inappropriate content</li>
          <li>Attempt to reverse engineer, decompile, or hack the App</li>
          <li>Use the App to spam or send unsolicited communications</li>
          <li>Share your account credentials with others</li>
          <li>Resell or redistribute the App or its services</li>
          <li>Interfere with the App's operation or infrastructure</li>
          <li>Generate content that infringes copyright or trademarks</li>
          <li>Use the App for fraudulent or malicious purposes</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>7. Content and Intellectual Property</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>7.1 Your Content</h3>
        <ul style={{ marginLeft: '20px' }}>
          <li>You retain all rights to content you input into the App</li>
          <li>You grant us a license to process your content to provide the service</li>
          <li>You are responsible for ensuring you have rights to all content you submit</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>7.2 Generated Content</h3>
        <ul style={{ marginLeft: '20px' }}>
          <li>AI-generated content is provided "as-is"</li>
          <li>You are responsible for reviewing and approving all generated content</li>
          <li>We do not guarantee accuracy, quality, or suitability of generated content</li>
          <li>Generated content may not be unique and may be similar to content generated for other users</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>7.3 Our Intellectual Property</h3>
        <p>
          The App, including its design, code, features, and branding, is owned by
          {companyName} and protected by intellectual property laws. You may not copy,
          modify, or distribute any part of the App without our permission.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>8. AI Services and Third Parties</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>8.1 Third-Party AI Providers</h3>
        <p>
          The App uses third-party AI services (Hugging Face, Google Gemini, OpenAI, Anthropic).
          Your content may be processed by these services in accordance with their terms
          and privacy policies.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>8.2 No Guarantees</h3>
        <p>
          We do not guarantee the availability, accuracy, or quality of third-party AI services.
          Service interruptions or changes by third-party providers may affect the App's functionality.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>9. Disclaimers and Warranties</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>9.1 "AS IS" Service</h3>
        <p>
          THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
          EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>9.2 No Guarantee</h3>
        <p>We do not guarantee that:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>The App will be error-free or uninterrupted</li>
          <li>Defects will be corrected</li>
          <li>The App is free from viruses or harmful components</li>
          <li>Generated content will meet your requirements</li>
          <li>Results will be accurate, reliable, or complete</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>10. Limitation of Liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, {companyName.toUpperCase()} SHALL NOT BE LIABLE FOR:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Indirect, incidental, special, consequential, or punitive damages</li>
          <li>Loss of profits, revenue, data, or business opportunities</li>
          <li>Service interruptions or data loss</li>
          <li>Actions or inactions of third-party AI providers</li>
          <li>Content generated by the AI that may be inaccurate or inappropriate</li>
        </ul>
        <p>
          Our total liability shall not exceed the amount you paid us in the 12 months
          preceding the claim, or €100, whichever is greater.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>11. Indemnification</h2>
        <p>
          You agree to indemnify and hold harmless {companyName} from any claims, damages,
          losses, or expenses (including legal fees) arising from:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Your use of the App</li>
          <li>Your violation of these Terms</li>
          <li>Your violation of any laws or third-party rights</li>
          <li>Content you submit or generate through the App</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>12. Termination</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>12.1 By You</h3>
        <p>You may terminate your use of the App at any time by uninstalling it from your Shopify store.</p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>12.2 By Us</h3>
        <p>We may suspend or terminate your access immediately if you:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Violate these Terms</li>
          <li>Engage in fraudulent or abusive behavior</li>
          <li>Fail to pay subscription fees</li>
          <li>Pose a security risk</li>
        </ul>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>12.3 Effect of Termination</h3>
        <p>Upon termination:</p>
        <ul style={{ marginLeft: '20px' }}>
          <li>Your right to use the App ceases immediately</li>
          <li>Active subscriptions are cancelled</li>
          <li>Your data may be deleted in accordance with our Privacy Policy</li>
          <li>No refunds for partial periods</li>
        </ul>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>13. Changes to Terms</h2>
        <p>
          We may modify these Terms at any time. Material changes will be notified via:
        </p>
        <ul style={{ marginLeft: '20px' }}>
          <li>In-app notification</li>
          <li>Email to your store's email address</li>
          <li>Update to the "Last Updated" date</li>
        </ul>
        <p>
          Continued use after changes constitutes acceptance of the modified Terms.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>14. Governing Law and Disputes</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>14.1 Governing Law</h3>
        <p>
          These Terms are governed by the laws of Switzerland, without regard to
          conflict of law principles.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>14.2 Dispute Resolution</h3>
        <p>
          Any disputes shall be resolved through good-faith negotiation. If negotiation
          fails, disputes shall be resolved through arbitration in Switzerland.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>15. General Provisions</h2>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>15.1 Entire Agreement</h3>
        <p>
          These Terms, together with our Privacy Policy, constitute the entire agreement
          between you and {companyName} regarding the App.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>15.2 Severability</h3>
        <p>
          If any provision is found unenforceable, the remaining provisions remain in effect.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>15.3 No Waiver</h3>
        <p>
          Failure to enforce any provision does not constitute a waiver of that provision.
        </p>

        <h3 style={{ fontSize: '1.4rem', marginTop: '20px', marginBottom: '10px' }}>15.4 Assignment</h3>
        <p>
          You may not assign these Terms without our consent. We may assign these Terms
          to any successor or affiliate.
        </p>
      </section>

      <section style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.8rem', marginTop: '30px', marginBottom: '15px' }}>16. Contact Information</h2>
        <p>
          For questions about these Terms, please contact:
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

      <hr style={{ margin: '40px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

      <footer style={{ textAlign: 'center', color: '#666', fontSize: '0.9rem' }}>
        <p>© 2026 {companyName}. All rights reserved.</p>
        <p>
          <a href={appUrl} style={{ color: '#2c6ecb', textDecoration: 'none' }}>Back to App</a>
          {' | '}
          <a href="/privacy" style={{ color: '#2c6ecb', textDecoration: 'none' }}>Privacy Policy</a>
        </p>
      </footer>
    </div>
  );
}
