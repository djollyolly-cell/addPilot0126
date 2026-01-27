/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adAccounts from "../adAccounts.js";
import type * as auth from "../auth.js";
import type * as authEmail from "../authEmail.js";
import type * as authInternal from "../authInternal.js";
import type * as rules from "../rules.js";
import type * as users from "../users.js";
import type * as vkApi from "../vkApi.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  adAccounts: typeof adAccounts;
  auth: typeof auth;
  authEmail: typeof authEmail;
  authInternal: typeof authInternal;
  rules: typeof rules;
  users: typeof users;
  vkApi: typeof vkApi;
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
