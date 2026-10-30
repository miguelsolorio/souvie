// Identity schemas (WS01). Row shapes mirror supabase/migrations/*_identity.sql, so they use
// the database's snake_case column names. docs/02-data-model.md §Identity is the reference.
import { z } from "zod";

/** Timestamps as PostgREST returns them, for example 2026-10-30T07:12:14.123456+00:00. */
const Timestamp = z.iso.datetime({ offset: true });

export const HOUSEHOLD_NAME_MAX = 80;
export const DISPLAY_NAME_MAX = 80;

export const HouseholdRole = z.enum(["owner", "member"]);
export type HouseholdRole = z.infer<typeof HouseholdRole>;

/** A household name as the user types it. The database applies the same 1 to 80 rule. */
export const HouseholdName = z.string().trim().min(1).max(HOUSEHOLD_NAME_MAX);

/** Input for the create_household RPC. */
export const CreateHouseholdInput = z.object({ name: HouseholdName });
export type CreateHouseholdInput = z.infer<typeof CreateHouseholdInput>;

export const Household = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(HOUSEHOLD_NAME_MAX),
  zip: z.string().nullable(),
  /** Points at retailer_connections.id. The foreign key arrives with WS07. */
  default_connection_id: z.uuid().nullable(),
  created_by: z.uuid().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  deleted_at: Timestamp.nullable(),
});
export type Household = z.infer<typeof Household>;

export const HouseholdMember = z.object({
  household_id: z.uuid(),
  user_id: z.uuid(),
  role: HouseholdRole,
  invited_by: z.uuid().nullable(),
  created_at: Timestamp,
});
export type HouseholdMember = z.infer<typeof HouseholdMember>;

/** One row of the list_household_members RPC: a member plus the name and avatar housemates see. */
export const HouseholdRosterEntry = z.object({
  user_id: z.uuid(),
  role: HouseholdRole,
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  joined_at: Timestamp,
});
export type HouseholdRosterEntry = z.infer<typeof HouseholdRosterEntry>;

export const SKILL_LEVELS = ["beginner", "comfortable", "confident"] as const;
export const LEFTOVER_STANCES = ["avoid", "ok", "prefer"] as const;

/**
 * The shape of profiles.preferences from docs/02-data-model.md. Per user, not per household,
 * because allergies and dislikes belong to a person. Every field is optional: the column starts
 * as {} and WS06 fills it during onboarding.
 *
 * Unknown keys pass through untouched, so WS06 can extend the shape without this schema
 * stripping its fields. The allergen and diet vocabularies (ALLERGENS, DIETS) are WS06's, so
 * `diets` and `allergies` are plain string lists here. Allergies are enforced in SQL and
 * deterministic code, never by a model alone (CLAUDE.md).
 */
export const ProfilePreferences = z.looseObject({
  diets: z.array(z.string()).optional(),
  allergies: z.array(z.string()).optional(),
  dislikes: z.array(z.string()).optional(),
  cuisines: z.array(z.string()).optional(),
  skill: z.enum(SKILL_LEVELS).optional(),
  weeknight_minutes: z.number().int().positive().optional(),
  budget_per_week_usd: z.number().nonnegative().optional(),
  equipment: z.array(z.string()).optional(),
  portions: z.number().positive().optional(),
  leftovers: z.enum(LEFTOVER_STANCES).optional(),
  primaryStoreId: z.string().optional(),
  notes: z.string().optional(),
});
export type ProfilePreferences = z.infer<typeof ProfilePreferences>;

export const Profile = z.object({
  user_id: z.uuid(),
  display_name: z.string().max(DISPLAY_NAME_MAX).nullable(),
  /** Object path inside the private `avatars` bucket: <user_id>/<file>. Not a URL. */
  avatar_url: z.string().nullable(),
  preferences: ProfilePreferences.default({}),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Profile = z.infer<typeof Profile>;

/** What the profile screen may change. */
export const ProfileUpdateInput = z.object({
  display_name: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
});
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateInput>;
