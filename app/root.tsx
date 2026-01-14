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
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <Document title={`${error.status} ${error.statusText}`}>
        <div style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          maxWidth: '600px',
          margin: '4rem auto',
          textAlign: 'center'
        }}>
          <h1 style={{ fontSize: '4rem', margin: '0', color: '#e74c3c' }}>
            {error.status}
          </h1>
          <h2 style={{ fontSize: '1.5rem', marginTop: '1rem', color: '#333' }}>
            {error.status === 404 ? 'Page Not Found' : 'App Unavailable'}
          </h2>
          <p style={{ fontSize: '1.1rem', color: '#666', marginTop: '1rem', lineHeight: '1.6' }}>
            {error.status === 404
              ? 'The page you are looking for does not exist.'
              : 'This app is currently unavailable.'}
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
