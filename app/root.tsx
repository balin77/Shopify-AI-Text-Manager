import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "@remix-run/react";
import { AppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const host = url.searchParams.get("host") || "";

  return json({
    apiKey,
    host,
  });
};

export default function App() {
  const { apiKey, host } = useLoaderData<typeof loader>();

  return (
    <html lang="de">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
        <script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
        />
        {apiKey && host && (
          <script
            dangerouslySetInnerHTML={{
              __html: `
                window.shopifyConfig = {
                  apiKey: "${apiKey}",
                  host: "${host}",
                  forceRedirect: true
                };
              `,
            }}
          />
        )}
      </head>
      <body>
        <AppProvider i18n={{}}>
          <Outlet />
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
