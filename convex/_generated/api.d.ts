/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accessControl from "../accessControl.js";
import type * as adAccounts from "../adAccounts.js";
import type * as admin from "../admin.js";
import type * as adminAlerts from "../adminAlerts.js";
import type * as adminHealth from "../adminHealth.js";
import type * as adminLogs from "../adminLogs.js";
import type * as adminMetrics from "../adminMetrics.js";
import type * as adminRuleDiagnostic from "../adminRuleDiagnostic.js";
import type * as agencyProviders from "../agencyProviders.js";
import type * as aiCabinet from "../aiCabinet.js";
import type * as aiGenerate from "../aiGenerate.js";
import type * as aiLimits from "../aiLimits.js";
import type * as aiRecommendations from "../aiRecommendations.js";
import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as authEmail from "../authEmail.js";
import type * as authInternal from "../authInternal.js";
import type * as bannerStyles from "../bannerStyles.js";
import type * as billing from "../billing.js";
import type * as budgetHealthCheck from "../budgetHealthCheck.js";
import type * as businessDirections from "../businessDirections.js";
import type * as creativeAnalytics from "../creativeAnalytics.js";
import type * as creatives from "../creatives.js";
import type * as credentialHistory from "../credentialHistory.js";
import type * as crons from "../crons.js";
import type * as customRules from "../customRules.js";
import type * as email from "../email.js";
import type * as healthCheck from "../healthCheck.js";
import type * as healthReport from "../healthReport.js";
import type * as http from "../http.js";
import type * as loadUnits from "../loadUnits.js";
import type * as logCleanup from "../logCleanup.js";
import type * as metrics from "../metrics.js";
import type * as migrations from "../migrations.js";
import type * as orgAuth from "../orgAuth.js";
import type * as organizations from "../organizations.js";
import type * as rateLimit from "../rateLimit.js";
import type * as referrals from "../referrals.js";
import type * as reports from "../reports.js";
import type * as ruleEngine from "../ruleEngine.js";
import type * as rules from "../rules.js";
import type * as shared_ruleConstants from "../shared/ruleConstants.js";
import type * as syncMetrics from "../syncMetrics.js";
import type * as systemLogger from "../systemLogger.js";
import type * as telegram from "../telegram.js";
import type * as testPrompts from "../testPrompts.js";
import type * as tokenRecovery from "../tokenRecovery.js";
import type * as userNotifications from "../userNotifications.js";
import type * as userSettings from "../userSettings.js";
import type * as users from "../users.js";
import type * as uzBudgetCron from "../uzBudgetCron.js";
import type * as uzBudgetHelpers from "../uzBudgetHelpers.js";
import type * as videos from "../videos.js";
import type * as vkApi from "../vkApi.js";
import type * as vkApiLimits from "../vkApiLimits.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accessControl: typeof accessControl;
  adAccounts: typeof adAccounts;
  admin: typeof admin;
  adminAlerts: typeof adminAlerts;
  adminHealth: typeof adminHealth;
  adminLogs: typeof adminLogs;
  adminMetrics: typeof adminMetrics;
  adminRuleDiagnostic: typeof adminRuleDiagnostic;
  agencyProviders: typeof agencyProviders;
  aiCabinet: typeof aiCabinet;
  aiGenerate: typeof aiGenerate;
  aiLimits: typeof aiLimits;
  aiRecommendations: typeof aiRecommendations;
  auditLog: typeof auditLog;
  auth: typeof auth;
  authEmail: typeof authEmail;
  authInternal: typeof authInternal;
  bannerStyles: typeof bannerStyles;
  billing: typeof billing;
  budgetHealthCheck: typeof budgetHealthCheck;
  businessDirections: typeof businessDirections;
  creativeAnalytics: typeof creativeAnalytics;
  creatives: typeof creatives;
  credentialHistory: typeof credentialHistory;
  crons: typeof crons;
  customRules: typeof customRules;
  email: typeof email;
  healthCheck: typeof healthCheck;
  healthReport: typeof healthReport;
  http: typeof http;
  loadUnits: typeof loadUnits;
  logCleanup: typeof logCleanup;
  metrics: typeof metrics;
  migrations: typeof migrations;
  orgAuth: typeof orgAuth;
  organizations: typeof organizations;
  rateLimit: typeof rateLimit;
  referrals: typeof referrals;
  reports: typeof reports;
  ruleEngine: typeof ruleEngine;
  rules: typeof rules;
  "shared/ruleConstants": typeof shared_ruleConstants;
  syncMetrics: typeof syncMetrics;
  systemLogger: typeof systemLogger;
  telegram: typeof telegram;
  testPrompts: typeof testPrompts;
  tokenRecovery: typeof tokenRecovery;
  userNotifications: typeof userNotifications;
  userSettings: typeof userSettings;
  users: typeof users;
  uzBudgetCron: typeof uzBudgetCron;
  uzBudgetHelpers: typeof uzBudgetHelpers;
  videos: typeof videos;
  vkApi: typeof vkApi;
  vkApiLimits: typeof vkApiLimits;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
