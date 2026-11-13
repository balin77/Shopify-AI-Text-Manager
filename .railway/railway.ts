import { defineRailway, github, project, service } from "railway/iac";
// Railway Infrastructure as Code for the ContentPilot project (replaces the
// Config-as-Code files railway.json, railway.dbbackup.json, railway.dbalert.json,
// which Railway stops reading on 2026-12-01).
//
// Railway does NOT read this file on deploy. Changes take effect only via
// `railway config plan` / `railway config apply`, run once per environment
// (production and Development). Variables are unmanaged: this file never
// reads or writes service variables.
//
// This repository manages only its own resources in the environment.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "Contentpilot";

export default defineRailway((ctx) => {
  const prod = ctx.environment === "production";
  const repo = "balin77/Shopify-AI-Text-Manager";
  const branch = prod ? "master" : "develop";
  const dockerBuild = { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" } as const;

  // Main app. Start chain runs migrations once (see scripts/run-all-migrations.js);
  // the long healthcheck timeout covers migrations on boot.
  const Contentpilot = service("Contentpilot", {
    source: github(repo, { branch, checkSuites: false }),
    build: dockerBuild,
    start: "npm run start:production",
    healthcheck: "/health",
    healthcheckTimeout: 900,
    replicas: { "us-west2": 1 },
    ...(prod ? { domains: ["www.contentpilot-ai.com"] } : {}),
    networking: { privateNetworkEndpoint: prod ? "contentpilotai" : "shopify-ai-text-manager" },
    deploy: {
      // Must stay above the shutdown bound in server.js (see comment there).
      drainingSeconds: 15,
      // Restart policy: Railway default ON_FAILURE with 10 retries (left implicit,
      // Railway stores the default as unset and would show a permanent diff).
      sleepApplication: !prod,
    },
  });

  // Nightly DB backup cron (was railway.dbbackup.json).
  const DbBackup = service(prod ? "Db Backup" : "Db Backup dev", {
    source: github(repo, { branch, checkSuites: false }),
    build: dockerBuild,
    start: "node scripts/db-backup.mjs",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "0 2 * * *", restartPolicyType: "NEVER" },
  });

  const resources = [Contentpilot, DbBackup];

  // DB space alert cron, production only (was railway.dbalert.json).
  if (prod) {
    resources.push(
      service("Db Space Checker", {
        source: github(repo, { branch, checkSuites: false }),
        build: dockerBuild,
        start: "node scripts/db-alert.mjs",
        replicas: { "us-west2": 1 },
        deploy: { cronSchedule: "*/15 * * * *", restartPolicyType: "NEVER" },
      }),
    );
  }

  return project("ContentPilot", {
    variables: { managed: false },
    resources,
  });
});
