/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as billing_index from "../billing/index.js";
import type * as connector_authorize from "../connector/authorize.js";
import type * as connector_consent from "../connector/consent.js";
import type * as connector_exec from "../connector/exec.js";
import type * as connector_gate from "../connector/gate.js";
import type * as connector_grantAccess from "../connector/grantAccess.js";
import type * as connector_grants from "../connector/grants.js";
import type * as connector_oauth from "../connector/oauth.js";
import type * as connector_subject from "../connector/subject.js";
import type * as connector_audit from "../connector/audit.js";
import type * as connector_config from "../connector/config.js";
import type * as connector_crypto from "../connector/crypto.js";
import type * as connector_errors from "../connector/errors.js";
import type * as connector_httpUtil from "../connector/httpUtil.js";
import type * as connector_idempotency from "../connector/idempotency.js";
import type * as connector_manifest from "../connector/manifest.js";
import type * as connector_openapi from "../connector/openapi.js";
import type * as connector_rateLimit from "../connector/rateLimit.js";
import type * as connector_registry from "../connector/registry.js";
import type * as connector_router from "../connector/router.js";
import type * as connector_routes from "../connector/routes.js";
import type * as connector_scopes from "../connector/scopes.js";
import type * as connector_standard from "../connector/standard.js";
import type * as dashboard_index from "../dashboard/index.js";
import type * as http from "../http.js";
import type * as insights_index from "../insights/index.js";
import type * as integrations_index from "../integrations/index.js";
import type * as invitationEmailState from "../invitationEmailState.js";
import type * as invitationsDelivery from "../invitationsDelivery.js";
import type * as invitations_index from "../invitations/index.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_connectorFields from "../lib/connectorFields.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_invitations from "../lib/invitations.js";
import type * as lib_meetingPermissions from "../lib/meetingPermissions.js";
import type * as lib_meetinghelpers from "../lib/meetinghelpers.js";
import type * as meetings_index from "../meetings/index.js";
import type * as meetings_summaryChunks from "../meetings/summaryChunks.js";
import type * as messages_index from "../messages/index.js";
import type * as notifications_index from "../notifications/index.js";
import type * as organization_index from "../organization/index.js";
import type * as participants_index from "../participants/index.js";
import type * as reactions_index from "../reactions/index.js";
import type * as recordings_index from "../recordings/index.js";
import type * as signals_index from "../signals/index.js";
import type * as tasks_index from "../tasks/index.js";
import type * as transcripts_index from "../transcripts/index.js";
import type * as users_index from "../users/index.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "billing/index": typeof billing_index;
  "connector/authorize": typeof connector_authorize;
  "connector/consent": typeof connector_consent;
  "connector/exec": typeof connector_exec;
  "connector/gate": typeof connector_gate;
  "connector/grantAccess": typeof connector_grantAccess;
  "connector/grants": typeof connector_grants;
  "connector/oauth": typeof connector_oauth;
  "connector/subject": typeof connector_subject;
  "connector/audit": typeof connector_audit;
  "connector/config": typeof connector_config;
  "connector/crypto": typeof connector_crypto;
  "connector/errors": typeof connector_errors;
  "connector/httpUtil": typeof connector_httpUtil;
  "connector/idempotency": typeof connector_idempotency;
  "connector/manifest": typeof connector_manifest;
  "connector/openapi": typeof connector_openapi;
  "connector/rateLimit": typeof connector_rateLimit;
  "connector/registry": typeof connector_registry;
  "connector/router": typeof connector_router;
  "connector/routes": typeof connector_routes;
  "connector/scopes": typeof connector_scopes;
  "connector/standard": typeof connector_standard;
  "dashboard/index": typeof dashboard_index;
  http: typeof http;
  "insights/index": typeof insights_index;
  "integrations/index": typeof integrations_index;
  invitationEmailState: typeof invitationEmailState;
  invitationsDelivery: typeof invitationsDelivery;
  "invitations/index": typeof invitations_index;
  "lib/actor": typeof lib_actor;
  "lib/auth": typeof lib_auth;
  "lib/connectorFields": typeof lib_connectorFields;
  "lib/errors": typeof lib_errors;
  "lib/invitations": typeof lib_invitations;
  "lib/meetingPermissions": typeof lib_meetingPermissions;
  "lib/meetinghelpers": typeof lib_meetinghelpers;
  "meetings/index": typeof meetings_index;
  "meetings/summaryChunks": typeof meetings_summaryChunks;
  "messages/index": typeof messages_index;
  "notifications/index": typeof notifications_index;
  "organization/index": typeof organization_index;
  "participants/index": typeof participants_index;
  "reactions/index": typeof reactions_index;
  "recordings/index": typeof recordings_index;
  "signals/index": typeof signals_index;
  "tasks/index": typeof tasks_index;
  "transcripts/index": typeof transcripts_index;
  "users/index": typeof users_index;
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
