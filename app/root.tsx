import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import "@shopify/polaris/build/esm/styles.css";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  return json({
    apiKey,
  });
};

function Document({ children, title = "App" }: { children: React.ReactNode; title?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <Document>
      <meta name="shopify-api-key" content={apiKey} />
      <link rel="preconnect" href="https://cdn.shopify.com/" />
      <link
        rel="stylesheet"
        href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
      />
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      <Outlet />
    </Document>
  );
}

export function ErrorBoundary() {
  let error: unknown;

  try {
    error = useRouteError();
  } catch (e) {
    // If useRouteError fails (e.g., called outside router context),
    // render a generic error page
    return (
      <Document title="Error">
        <div style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          maxWidth: '600px',
          margin: '4rem auto',
          textAlign: 'center'
        }}>
          <h1 style={{ fontSize: '4rem', margin: '0', color: '#e74c3c' }}>
            Error
          </h1>
          <h2 style={{ fontSize: '1.5rem', marginTop: '1rem', color: '#333' }}>
            App Unavailable
          </h2>
          <p style={{ fontSize: '1.1rem', color: '#666', marginTop: '1rem', lineHeight: '1.6' }}>
            This app is currently unavailable. Please try again later.
          </p>
          <p style={{ fontSize: '1rem', color: '#888', marginTop: '1rem' }}>
            If this problem persists, please contact the app administrator.
          </p>
          <a
            href="/"
            style={{
              display: 'inline-block',
              marginTop: '2rem',
              padding: '0.75rem 1.5rem',
              backgroundColor: '#008060',
              color: 'white',
              textDecoration: 'none',
              borderRadius: '4px',
              fontWeight: '500'
            }}
          >
            Go to Home
          </a>
        </div>
      </Document>
    );
  }

  if (isRouteErrorResponse(error)) {
    return (
      <Document title={`${error.status} ${error.statusText}`}>
        <style>{`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
          }
          .error-container {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            padding: 2rem;
          }
          .error-content {
            max-width: 600px;
            text-align: center;
            animation: fadeIn 0.6s ease-out;
          }
          .error-icon {
            font-size: 8rem;
            margin-bottom: 1rem;
            animation: float 3s ease-in-out infinite;
          }
          .error-code {
            font-size: 6rem;
            font-weight: 700;
            margin: 0;
            background: linear-gradient(135deg, #5c6ac4 0%, #202e78 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            line-height: 1.2;
          }
          .error-title {
            font-size: 2rem;
            margin: 1.5rem 0 1rem;
            color: #202223;
            font-weight: 600;
          }
          .error-message {
            font-size: 1.125rem;
            color: #6d7175;
            line-height: 1.6;
            margin: 1rem 0 2rem;
          }
          .error-actions {
            display: flex;
            gap: 1rem;
            justify-content: center;
            flex-wrap: wrap;
            margin-top: 2rem;
          }
          .btn-primary {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.875rem 1.75rem;
            background: #008060;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 1rem;
            transition: all 0.2s ease;
            box-shadow: 0 2px 8px rgba(0, 128, 96, 0.2);
          }
          .btn-primary:hover {
            background: #006e52;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 128, 96, 0.3);
          }
          .btn-secondary {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.875rem 1.75rem;
            background: white;
            color: #202223;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 1rem;
            transition: all 0.2s ease;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            border: 1px solid #c9cccf;
          }
          .btn-secondary:hover {
            background: #f6f6f7;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          }
          .error-card {
            background: white;
            padding: 3rem 2rem;
            border-radius: 12px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
          }
        `}</style>
        <div className="error-container">
          <div className="error-content">
            <div className="error-card">
              <div className="error-icon">
                {error.status === 404 ? '🔍' : '⚠️'}
              </div>
              <h1 className="error-code">{error.status}</h1>
              <h2 className="error-title">
                {error.status === 404 ? 'Page Not Found' : 'Something Went Wrong'}
              </h2>
              <p className="error-message">
                {error.status === 404
                  ? "The page you're looking for doesn't exist or has been moved. Let's get you back on track."
                  : 'We encountered an unexpected error. Please try again or return to the home page.'}
              </p>
              <div className="error-actions">
                <a href="/" className="btn-primary">
                  <span>← Back to Home</span>
                </a>
                {error.status === 404 && (
                  <a href="/app" className="btn-secondary">
                    <span>Go to Dashboard</span>
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </Document>
    );
  }

  return (
    <Document title="Error">
      <div style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: '600px',
        margin: '4rem auto',
        textAlign: 'center'
      }}>
        <h1 style={{ fontSize: '4rem', margin: '0', color: '#e74c3c' }}>
          Error
        </h1>
        <h2 style={{ fontSize: '1.5rem', marginTop: '1rem', color: '#333' }}>
          App Unavailable
        </h2>
        <p style={{ fontSize: '1.1rem', color: '#666', marginTop: '1rem', lineHeight: '1.6' }}>
          This app is currently unavailable. Please try again later.
        </p>
        <p style={{ fontSize: '1rem', color: '#888', marginTop: '1rem' }}>
          If this problem persists, please contact the app administrator.
        </p>
        <a
          href="/"
          style={{
            display: 'inline-block',
            marginTop: '2rem',
            padding: '0.75rem 1.5rem',
            backgroundColor: '#008060',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '4px',
            fontWeight: '500'
          }}
        >
          Go to Home
        </a>
      </div>
    </Document>
  );
}
